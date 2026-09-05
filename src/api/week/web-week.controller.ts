import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ActionsService } from "../../actions/actions.service.js";
import type { ResolvedAction } from "../../core/ai-actions.js";
import type { TaskTarget } from "../../core/ai-contract.js";
import { paginate } from "../../core/task-list-view.js";
import { localDateAt } from "../../core/timezone.js";
import { isPickLive, isPickStale, previousWeekRange, targetWeekStart, WEEK_PICK_LIMIT } from "../../core/week-plan.js";
import { TasksService } from "../../tasks/tasks.service.js";
import { CurrentUser, InitDataGuard, type WebAuthContext } from "../auth/index.js";
import {
  UuidSchema,
  WeekPickResponseSchema,
  WeekQuerySchema,
  WeekResponseSchema,
  WeekTakeTodayRequestSchema,
  WeekTakeTodayResponseSchema,
  type WeekPickResponse,
  type WeekPoolRow,
  type WeekQuery,
  type WeekResponse,
  type WeekTakeTodayRequest,
  type WeekTakeTodayResponse,
} from "../contracts/index.js";
import { ApiError, apiRoute, errorForIssues, pageInfo, rethrowWriteError, zodBody, zodParam, zodQuery } from "../http/index.js";

/**
 * The week plan: the pool of dateless work, the handful taken for the coming week, and the one tap
 * that gives a pooled task today's date.
 *
 * The whole screen turns on one value — the Monday of the week a pick made *now* is for — and that
 * value is derived twice over from things only the server knows: the instant, and the timezone on
 * the user's settings row. `localDateAt` resolves the first into a local day, `targetWeekStart` the
 * second into a Monday, and every derived answer (`picked`, `stale`, the previous week's range) is
 * computed from that one day. None of it is recomputed in the browser: a phone in another timezone
 * would name a different Monday, and on a Sunday — the day the week card arrives, and the one day
 * the rule bends — it would name the wrong week entirely.
 *
 * Nothing here decides anything about the week. `targetWeekStart`, `isPickLive` and `isPickStale`
 * are `src/core/week-plan.ts` and are called, not restated; the pick itself is
 * `TasksService.togglePickedForWeek`, the same transaction the `wk:t` button runs; and «делаю
 * сегодня» is the same `reschedule` action `wk:d` builds, applied through `ActionsService` so the
 * change journals and undoes exactly like the button's.
 */
@Controller(apiRoute("week"))
@UseGuards(InitDataGuard)
export class WebWeekController {
  constructor(
    private readonly tasks: TasksService,
    private readonly actions: ActionsService,
  ) {}

  /** The pool and the current pick, plus what the week that just ended actually did. */
  @Get()
  async week(@CurrentUser() user: WebAuthContext, @Query(zodQuery(WeekQuerySchema)) query: WeekQuery): Promise<WeekResponse> {
    const today = this.todayFor(user);
    const plan = await this.tasks.listWeekPlanForTelegram(user.access.workspaceId, today);
    const rows = plan.rows.map((task) => poolRow(task, today));
    const view = paginate(rows, query.page, query.pageSize);

    return WeekResponseSchema.parse({
      // `plan.weekStart` is `targetWeekStart(today)`; it is taken from the service so the list and
      // the mark it was sorted by can never be one call apart.
      targetWeekStart: plan.weekStart,
      todayLocalDate: today,
      timezone: user.settings.timezone,
      rows: view.items,
      // `total` counts the rows this endpoint can actually page through, not `plan.total`: the
      // repository caps the pool it materialises, and a total the pages cannot reach makes an
      // infinite list ask for a page that clamps back to the last one and repeat it for ever.
      page: pageInfo(view, rows.length, query.pageSize),
      pickLimit: WEEK_PICK_LIMIT,
      pickedCount: rows.filter((row) => row.picked).length,
      summary: plan.summary,
      previousWeek: previousWeekRange(today),
    } satisfies WeekResponse);
  }

  /** Take a pool task for the coming week. */
  @Post("pick/:taskId")
  @HttpCode(200)
  pick(@CurrentUser() user: WebAuthContext, @Param("taskId", zodParam(UuidSchema)) taskId: string): Promise<WeekPickResponse> {
    return this.setPicked(user, taskId, true);
  }

  /** Put it back. */
  @Delete("pick/:taskId")
  release(@CurrentUser() user: WebAuthContext, @Param("taskId", zodParam(UuidSchema)) taskId: string): Promise<WeekPickResponse> {
    return this.setPicked(user, taskId, false);
  }

  /**
   * `wk:d` from the morning card: the task gets today as its day, which is what «делаю сегодня»
   * means. It is a `reschedule` through `ActionsService`, so a task with no occurrence becomes
   * concrete — first occurrence and default reminders in one transaction — and the group it writes
   * is undoable, exactly as the button's is.
   *
   * The pool has two kinds of row and so does this: a dateless task, and a one-off whose day has
   * passed. The second one already has a live occurrence, and it is that date which moves.
   */
  @Post("take-today/:taskId")
  @HttpCode(200)
  async takeToday(
    @CurrentUser() user: WebAuthContext,
    @Param("taskId", zodParam(UuidSchema)) taskId: string,
    @Body(zodBody(WeekTakeTodayRequestSchema)) body: WeekTakeTodayRequest,
  ): Promise<WeekTakeTodayResponse> {
    const { access, settings } = user;
    const today = this.todayFor(user);

    // Membership is `POOL_MEMBERSHIP`, read for this one id — not `timeMode === "fuzzy"`, which is
    // what the bot's `wk:d` asks and which is narrower than the pool it draws its rows from. The
    // pool also holds one-offs whose day has passed, the screen offers «делаю сегодня» on those
    // rows too, and refusing them would be a not-found for a row that is on screen. Gone, foreign,
    // closed or already dated are all the same answer, because `findPoolTask` is workspace-scoped.
    const task = await this.tasks.findPoolTask(access.workspaceId, taskId);
    if (!task) throw ApiError.notFound();
    // The row moved under the screen that offered the tap. The transaction checks the version again
    // and would refuse it as a domain rule; answering `conflict` here is what tells the client to
    // refetch rather than to show the user a rule they did not break.
    if (task.version !== body.expectedVersion) throw ApiError.conflict(task.version);

    // A dateless task is concretised — the whole task gains a first occurrence. An overdue one-off
    // already has one, and `concretise_task` refuses anything but a fuzzy task, so its live date is
    // what moves. The occurrence version is read here rather than sent: the pool row carries the
    // task's version and no occurrence at all, and the transaction re-checks what it reads.
    const current = task.timeMode === "fuzzy" ? null : await this.tasks.findCurrentOccurrence(access.workspaceId, task.id);
    const target: TaskTarget = current
      ? { kind: "occurrence", taskId: task.id, taskVersion: task.version, occurrenceId: current.id, occurrenceVersion: current.version, timezone: current.timezone }
      : { kind: "task", taskId: task.id, taskVersion: task.version };

    const action: ResolvedAction = {
      type: "reschedule",
      intent: "explicit",
      timezone: task.timezone,
      reviewTime: settings.morningReferenceTime ?? "09:00",
      target,
      // The day, not the hour: the pool is where a task's *next day* is chosen, so a missed 14:00
      // call becomes today's work rather than today at 14:00, which has usually also passed.
      when: { mode: "date", date: today },
      recurrence: null,
      reason: null,
    };
    const scope = { workspaceId: access.workspaceId, actorUserId: access.user.id, recipientUserId: access.user.id };
    // Validated before it is applied, so a rule the tap cannot satisfy — an overdue critical task
    // whose second move needs a reason — is the domain refusal the client can render and route to
    // the reschedule sheet, not a 500 from inside the transaction.
    const issues = await this.actions.validateResolved([action], scope);
    if (issues.length) throw errorForIssues(issues, task.version);
    const applied = await this.actions.applyResolved([action], scope).catch((error: unknown) => rethrowWriteError(error, task.version));

    // Read back rather than reported: the occurrence the client opens next is the one the
    // transaction committed, whether it was created here or already existed.
    const occurrence = await this.tasks.findCurrentOccurrence(access.workspaceId, task.id);
    return WeekTakeTodayResponseSchema.parse({
      taskId: task.id,
      occurrenceId: occurrence?.id ?? null,
      localDate: today,
      undoGroupId: applied.groupId,
    } satisfies WeekTakeTodayResponse);
  }

  /**
   * The pick and the release share one domain call, because the domain has one: `wk:t` is a toggle
   * and the same tap reverses it. A verb cannot be a toggle, though — a `POST` that released a task
   * because it happened to be picked would make the app's checkbox unusable the moment two taps
   * raced — so the current mark is read first and the toggle is called only when it would move the
   * row the way the verb asked. A verb that asks for the state the row is already in writes nothing
   * and answers as though it had.
   */
  private async setPicked(user: WebAuthContext, taskId: string, desired: boolean): Promise<WeekPickResponse> {
    const workspaceId = user.access.workspaceId;
    const today = this.todayFor(user);
    const weekStart = targetWeekStart(today);

    const plan = await this.tasks.listWeekPlanForTelegram(workspaceId, today);
    const rows = plan.rows.map((task) => poolRow(task, today));
    const respond = (result: WeekPickResponse["result"], row: WeekPoolRow | null): WeekPickResponse =>
      WeekPickResponseSchema.parse({ result, targetWeekStart: weekStart, pickedCount: rows.filter((candidate) => candidate.picked).length, row } satisfies WeekPickResponse);

    const index = rows.findIndex((row) => row.taskId === taskId);
    // Not in this workspace's pool: unknown, foreign, closed, or already given a day. One answer for
    // all four, and the same one the bot's toast gives — the limit and the missing row are product
    // outcomes of a legal tap, not failures of the request.
    if (index === -1) return respond("not_found", null);

    const current = rows[index]!;
    if (current.picked === desired) return respond(desired ? "picked" : "released", current);

    const outcome = await this.tasks.togglePickedForWeek(workspaceId, taskId, today);
    if (outcome === null) {
      // It left the pool between the read and the write. Indistinguishable from never having been
      // there, which is the point.
      rows.splice(index, 1);
      return respond("not_found", null);
    }
    if (outcome === "full") return respond("full", current);

    // The mark the transaction actually wrote — not the one this request asked for — put back
    // through the same two predicates the list was built with.
    const pickedWeekStart = outcome === "picked" ? weekStart : null;
    rows[index] = { ...current, pickedWeekStart, picked: isPickLive(pickedWeekStart, today), stale: isPickStale(pickedWeekStart, today) };
    return respond(outcome, rows[index]);
  }

  /**
   * The user's day, and the only clock reading in this file.
   *
   * `settings.timezone`, never UTC and never the server's: the offset in force at this instant is
   * what decides which day it is, so the Saturday night a timezone leaves DST is a Saturday for one
   * user and a Sunday for another — and `targetWeekStart` turns that one day of difference into a
   * whole week of it.
   */
  private todayFor(user: WebAuthContext): string {
    return localDateAt(new Date(), user.settings.timezone);
  }
}

/** One pool row, with both derived answers computed here so no client has to know the rule. */
function poolRow(
  task: { id: string; version: number; title: string; importance: WeekPoolRow["importance"]; pickedWeekStart: string | null; overdue?: boolean },
  today: string,
): WeekPoolRow {
  return {
    taskId: task.id,
    version: task.version,
    title: task.title,
    importance: task.importance,
    pickedWeekStart: task.pickedWeekStart ?? null,
    picked: isPickLive(task.pickedWeekStart, today),
    stale: isPickStale(task.pickedWeekStart, today),
    overdue: Boolean(task.overdue),
  };
}
