import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ActionsService, type ActionScope } from "../../actions/actions.service.js";
import type { ResolvedActionOf } from "../../core/ai-contract.js";
import { localDateAndTimeToUtc, localDateAt } from "../../core/timezone.js";
import { ReminderSchedulingService } from "../../reminders/reminder-scheduling.service.js";
import { TasksService } from "../../tasks/tasks.service.js";
import {
  ReminderCancelResponseSchema,
  ReminderMutationResponseSchema,
  ReminderRepeatRequestSchema,
  ReminderSnoozeRequestSchema,
  RemindersQuerySchema,
  RemindersResponseSchema,
  UuidSchema,
  type ReminderCancelResponse,
  type ReminderMutationResponse,
  type ReminderRepeatRequest,
  type ReminderSnoozeRequest,
  type RemindersQuery,
  type RemindersResponse,
} from "../contracts/index.js";
import { ApiError } from "../http/api-error.js";
import { apiRoute } from "../http/routes.js";
import { zodBody, zodParam, zodQuery } from "../http/zod-validation.pipe.js";
import { CurrentUser, InitDataGuard, type WebAuthContext } from "../auth/index.js";
import { apiErrorForIssues, rethrowWriteError } from "../settings/action-errors.js";
import { paginate } from "../settings/paging.js";
import { presentReminder, type UpcomingReminder } from "./reminders.presenter.js";

/**
 * The reminders screen: what the bot will say next, and the three things the user can do about it.
 *
 * Every read and every write goes through `ReminderSchedulingService.listUpcoming`, which filters on
 * `workspaceId` **and** `recipientUserId`. That is the workspace isolation for this whole file: a
 * delivery id from another workspace is simply not in the list, so it answers `not_found` — the same
 * envelope as an id that never existed, and never a 403 that would confirm the id is real.
 *
 * The window is read whole and paged in memory: the domain has no offset for this query, and adding
 * one in the API would be a second ordering that could disagree with the bot's.
 */
const WINDOW = 200;

@Controller(apiRoute("reminders"))
@UseGuards(InitDataGuard)
export class WebRemindersController {
  constructor(
    private readonly reminders: ReminderSchedulingService,
    private readonly tasks: TasksService,
    private readonly actions: ActionsService,
  ) {}

  @Get()
  async list(@CurrentUser() user: WebAuthContext, @Query(zodQuery(RemindersQuerySchema)) query: RemindersQuery): Promise<RemindersResponse> {
    const now = new Date();
    const rows = await this.upcoming(user, now);
    const paged = paginate(rows, query);
    return RemindersResponseSchema.parse({
      rows: paged.rows.map(presentReminder),
      page: paged.page,
      timezone: user.settings.timezone,
      todayLocalDate: localDateAt(now, user.settings.timezone),
      // Every row below is still scheduled: a notification snooze delays delivery, it does not
      // cancel anything, and a list that hid them would look like the reminders were lost.
      notificationsSnoozedUntil: user.settings.notificationsSnoozedUntil?.toISOString() ?? null,
    } satisfies RemindersResponse);
  }

  /** `follow:snooze:*` on the reminder card: say it again in 15 minutes or an hour. */
  @Post(":deliveryId/snooze")
  async snooze(
    @CurrentUser() user: WebAuthContext,
    @Param("deliveryId", zodParam(UuidSchema)) deliveryId: string,
    @Body(zodBody(ReminderSnoozeRequestSchema)) body: ReminderSnoozeRequest,
  ): Promise<ReminderMutationResponse> {
    const found = await this.find(user, deliveryId);
    const occurrenceId = found.delivery.occurrenceId;
    // A follow-up hangs on an occurrence; a delivery for a dateless task has none to hang it on.
    if (!occurrenceId) throw ApiError.domainRule("occurrence_required");

    const created = await this.reminders.scheduleFollowUpChoice({
      workspaceId: user.access.workspaceId,
      userId: user.access.user.id,
      occurrenceId,
      choice: body.choice,
    });
    // The occurrence finished or was cancelled between the list and the tap: the card's own answer
    // is «эта задача больше не ждёт ответа», and it is a domain refusal rather than a failure.
    if (!created) throw ApiError.domainRule("occurrence_terminal");

    const rows = await this.upcoming(user, new Date());
    const row = rows.find((candidate) => candidate.delivery.id === created);
    return ReminderMutationResponseSchema.parse({
      reminder: row ? presentReminder(row) : null,
      // A snooze is not journaled — it creates a contact, it changes no state — so there is nothing
      // truthful for Undo to restore. Claiming otherwise is how an Undo button starts lying.
      undoGroupId: null,
    } satisfies ReminderMutationResponse);
  }

  /**
   * Repeat this reminder at a time the user names.
   *
   * Unlike a snooze this is a real reminder on the occurrence, so it goes through `ActionsService`
   * as a `set_reminder` action: journaled, undoable, and validated by the rules that already refuse
   * a time in the past, a time inside quiet hours, and two explicit reminders closer than fifteen
   * minutes. Neither this nor snooze touches the task's own time.
   */
  @Post(":deliveryId/repeat")
  async repeat(
    @CurrentUser() user: WebAuthContext,
    @Param("deliveryId", zodParam(UuidSchema)) deliveryId: string,
    @Body(zodBody(ReminderRepeatRequestSchema)) body: ReminderRepeatRequest,
  ): Promise<ReminderMutationResponse> {
    const found = await this.find(user, deliveryId);
    const occurrenceId = found.delivery.occurrenceId;
    if (!occurrenceId) throw ApiError.domainRule("occurrence_required");

    const context = await this.tasks.getOccurrenceContext(user.access.workspaceId, occurrenceId);
    if (!context) throw ApiError.notFound();
    const timezone = context.occurrence.timezone;

    const action: ResolvedActionOf<"set_reminder"> = {
      type: "set_reminder",
      intent: "explicit",
      timezone,
      reviewTime: user.settings.morningReferenceTime,
      target: {
        kind: "occurrence",
        taskId: context.task.id,
        taskVersion: context.task.version,
        occurrenceId: context.occurrence.id,
        occurrenceVersion: context.occurrence.version,
        timezone,
      },
      mode: "add",
      reminder: { kind: "at", date: body.date, time: body.time, quiet: "respect" },
    };
    const scope: ActionScope = {
      workspaceId: user.access.workspaceId,
      actorUserId: user.access.user.id,
      recipientUserId: user.access.user.id,
      language: user.settings.pinnedLanguage ?? user.locale,
    };

    let groupId: string;
    try {
      const issues = await this.actions.validateResolved([action], scope);
      if (issues.length) throw apiErrorForIssues(issues, context.occurrence.version);
      groupId = (await this.actions.applyResolved([action], scope)).groupId;
    } catch (error) {
      rethrowWriteError(error, context.occurrence.version);
    }

    // Matched on `intendedFor`, not on `scheduledFor`: quiet hours may have pushed the delivery, and
    // the moment the user asked for is the one that survives that.
    const intendedFor = localDateAndTimeToUtc(body.date, body.time, timezone).date;
    const rows = await this.upcoming(user, new Date());
    const row = rows.find((candidate) => candidate.delivery.occurrenceId === occurrenceId && candidate.delivery.intendedFor.getTime() === intendedFor.getTime());
    return ReminderMutationResponseSchema.parse({ reminder: row ? presentReminder(row) : null, undoGroupId: groupId } satisfies ReminderMutationResponse);
  }

  /** `rem:cancel`: withdraw one pending delivery without touching the rule that produced it. */
  @Delete(":deliveryId")
  async cancel(@CurrentUser() user: WebAuthContext, @Param("deliveryId", zodParam(UuidSchema)) deliveryId: string): Promise<ReminderCancelResponse> {
    await this.find(user, deliveryId);
    const cancelled = await this.reminders.cancelUpcoming({ workspaceId: user.access.workspaceId, userId: user.access.user.id, deliveryId });
    // False means it stopped being pending between the two calls — it fired, or another surface
    // withdrew it. The bot answers «уже отправлено» to the same race rather than an error.
    return ReminderCancelResponseSchema.parse({ cancelled } satisfies ReminderCancelResponse);
  }

  private upcoming(user: WebAuthContext, now: Date): Promise<UpcomingReminder[]> {
    return this.reminders.listUpcoming({ workspaceId: user.access.workspaceId, userId: user.access.user.id, now, limit: WINDOW });
  }

  /** A delivery of this user, in this workspace, still pending — or the same 404 as a stranger's id. */
  private async find(user: WebAuthContext, deliveryId: string): Promise<UpcomingReminder> {
    const rows = await this.upcoming(user, new Date());
    const row = rows.find((candidate) => candidate.delivery.id === deliveryId);
    if (!row) throw ApiError.notFound();
    return row;
  }
}
