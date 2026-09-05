import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ActionsService, type ActionScope } from "../../actions/actions.service.js";
import type { ResolvedActionOf } from "../../core/ai-contract.js";
import { paginate } from "../../core/task-list-view.js";
import { localDateAt } from "../../core/timezone.js";
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
import { ApiError, apiRoute, errorForIssues, pageInfo, rethrowWriteError, zodBody, zodParam, zodQuery } from "../http/index.js";
import { CurrentUser, InitDataGuard, type WebAuthContext } from "../auth/index.js";
import { presentReminder, type UpcomingReminder } from "./reminders.presenter.js";

/**
 * The reminders screen: what the bot will say next, and the three things the user can do about it.
 *
 * Every read and every write goes through `ReminderSchedulingService`, whose every query filters on
 * `workspaceId` **and** `recipientUserId`. That is the workspace isolation for this whole file: a
 * delivery id from another workspace answers `not_found` — the same envelope as an id that never
 * existed, and never a 403 that would confirm the id is real.
 *
 * The window is read whole and paged in memory: the domain has no offset for this query, and adding
 * one in the API would be a second ordering that could disagree with the bot's. It bounds the
 * *list* only — every write addresses its delivery through `findUpcoming`, so a reminder past the
 * window is still snoozable, repeatable and cancellable.
 *
 * No write reads the list back. A snooze and a repeat both answer with the undo group and nothing
 * else: the client invalidates `reminders` and refetches, so a second 200-row read per write bought
 * a field nothing rendered — and answered `null` for exactly the deliveries that fell outside the
 * window, which is the read cap leaking into a write all over again.
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
    const view = paginate(rows, query.page, query.pageSize);
    return RemindersResponseSchema.parse({
      rows: view.items.map(presentReminder),
      page: pageInfo(view, rows.length, query.pageSize),
      timezone: user.settings.timezone,
      todayLocalDate: localDateAt(now, user.settings.timezone),
      // Every row below is still scheduled: a notification snooze delays delivery, it does not
      // cancel anything, and a list that hid them would look like the reminders were lost.
      notificationsSnoozedUntil: user.settings.notificationsSnoozedUntil?.toISOString() ?? null,
    } satisfies RemindersResponse);
  }

  /** `follow:snooze:*` on the reminder card: say it again in 15 minutes or an hour. */
  @Post(":deliveryId/snooze")
  @HttpCode(200)
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

    // A snooze is not journaled — it creates a contact, it changes no state — so there is nothing
    // truthful for Undo to restore. Claiming otherwise is how an Undo button starts lying.
    return ReminderMutationResponseSchema.parse({ undoGroupId: null } satisfies ReminderMutationResponse);
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
  @HttpCode(200)
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
      if (issues.length) throw errorForIssues(issues, context.occurrence.version);
      groupId = (await this.actions.applyResolved([action], scope)).groupId;
    } catch (error) {
      rethrowWriteError(error, context.occurrence.version);
    }

    return ReminderMutationResponseSchema.parse({ undoGroupId: groupId } satisfies ReminderMutationResponse);
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

  /**
   * A delivery of this user, in this workspace, still pending — or the same 404 as a stranger's id.
   *
   * Addressed by id, not found by scanning the list: the list is the `WINDOW` soonest deliveries,
   * and a reminder further out than that would otherwise be unreachable for a snooze, a repeat or a
   * cancel the domain would have performed. A read cap on a list is a paging question; a read cap
   * on the lookup a write depends on is a row that cannot be changed.
   */
  private async find(user: WebAuthContext, deliveryId: string): Promise<UpcomingReminder> {
    const row = await this.reminders.findUpcoming({ workspaceId: user.access.workspaceId, userId: user.access.user.id, deliveryId, now: new Date() });
    if (!row) throw ApiError.notFound();
    return row;
  }
}
