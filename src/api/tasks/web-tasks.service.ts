import { Injectable } from "@nestjs/common";
import { ActionsService, type ActionScope } from "../../actions/actions.service.js";
import { whenFromRescheduleFields } from "../../actions/action-conversion.js";
import { ContextService } from "../../context/context.service.js";
import type { ResolvedAction, TaskTarget, When } from "../../core/ai-contract.js";
import { DomainRuleError } from "../../core/errors.js";
import { paginate, type TaskScope as DomainTaskScope } from "../../core/task-list-view.js";
import { quickRescheduleSchedule, type QuickRescheduleChoice } from "../../core/telegram-ux.js";
import { localDateAndTimeToUtc, localDateAt, localDateTimeAt, shiftLocalDate } from "../../core/timezone.js";
import { ReminderSchedulingService } from "../../reminders/reminder-scheduling.service.js";
import { TasksService } from "../../tasks/tasks.service.js";
import type { WebAuthContext } from "../auth/index.js";
import type {
  ChecklistWriteRequest,
  CreateTaskRequest,
  OccurrenceStateRequest,
  PageQuery,
  PausedSeriesResponse,
  ReschedulePreset,
  RescheduleOptions,
  RescheduleRequest,
  SeriesRequest,
  TaskDetail,
  TaskListQuery,
  TaskListResponse,
  TaskMutationResponse,
  TodayResponse,
  UpdateTaskRequest,
} from "../contracts/index.js";
import {
  OccurrenceDetailSchema,
  PausedSeriesResponseSchema,
  RescheduleOptionsSchema,
  TaskDetailSchema,
  TaskListResponseSchema,
  TaskMutationResponseSchema,
  TodayResponseSchema,
} from "../contracts/index.js";
import { ApiError, errorForIssues, pageInfo } from "../http/index.js";
import {
  isLiveOccurrence,
  presentChecklist,
  presentFuzzy,
  presentGoalLink,
  presentGroup,
  presentJournal,
  presentOccurrenceDetail,
  presentPausedSeries,
  presentRecurrence,
  presentReminders,
  type OccurrenceRow,
  type TaskRow,
} from "./task.presenter.js";

/** The three presets the reminder card carries; the sheet and the card cannot drift apart. */
const PRESETS: readonly ReschedulePreset[] = ["1h", "evening", "tomorrow"];

/** The task and the occurrence one path segment addresses. A fuzzy task has no occurrence. */
interface TaskTargetRows {
  task: TaskRow;
  occurrence: OccurrenceRow | null;
}

/**
 * Every read and write the task screens make, expressed as calls to the domain services.
 *
 * Two rules shape the whole file, both from design.md § 5:
 *
 * - Every write goes through `ActionsService` with the versions the client read, so a change made
 *   in the app lands in the action journal exactly like the same change from a button — which is
 *   the only reason Undo can be offered for it at all.
 * - Nothing here decides a domain question. A stale version, a required reason, a terminal
 *   occurrence: all of them are answered by `validateResolved`, and this file only translates the
 *   issue it gets back into the one error envelope the contract defines.
 *
 * The state changes are the one place with two paths, and the split is not an accident.
 * `done`, `skipped` and `cancelled` are reversible transitions the journal knows how to undo, so
 * they go through the action group. `started` and `seen` are not: there is no `set_task_state`
 * for them, no `action_events` row that could be rolled back, and offering Undo for them would be
 * the lie `AGENTS.md` forbids by name. They go straight to `TasksService.setOccurrenceStatus`,
 * which journals the transition in `task_events` — where the blocker note lands too.
 */
@Injectable()
export class WebTasksService {
  constructor(
    private readonly tasks: TasksService,
    private readonly actions: ActionsService,
    private readonly context: ContextService,
    private readonly reminders: ReminderSchedulingService,
  ) {}

  /* ------------------------------------------------------------------- reads */

  async list(user: WebAuthContext, query: TaskListQuery): Promise<TaskListResponse> {
    const now = new Date();
    const timezone = user.settings.timezone;
    const todayLocalDate = localDateAt(now, timezone);
    const scope = query.scope as DomainTaskScope;
    // One call, not two: `listGrouped` already answers what every other tab would show, which is
    // the same `scopeCounts` the bot's filter row reads.
    const { groups, counts, pausedCount } = await this.tasks.listGrouped(user.access.workspaceId, { scope, localDate: todayLocalDate });
    const view = paginate(groups, query.page, query.pageSize);
    const reminders = await this.remindersForGroups(user, view.items);
    return TaskListResponseSchema.parse({
      scope: query.scope,
      groups: view.items.map((group) => presentGroup(group, now, reminders)),
      page: pageInfo(view, groups.length, query.pageSize),
      counts,
      pausedCount,
      todayLocalDate,
      timezone,
    } satisfies TaskListResponse);
  }

  async today(user: WebAuthContext, query: PageQuery): Promise<TodayResponse> {
    const now = new Date();
    const timezone = user.settings.timezone;
    const localDate = localDateAt(now, timezone);
    const [{ groups, staleCount }, completed] = await Promise.all([
      this.tasks.listTodayGrouped(user.access.workspaceId, localDate),
      this.tasks.listCompletedTodayForTelegram(user.access.workspaceId, localDate),
    ]);
    const view = paginate(groups, query.page, query.pageSize);
    const reminders = await this.remindersForGroups(user, view.items);
    return TodayResponseSchema.parse({
      localDate,
      timezone,
      groups: view.items.map((group) => presentGroup(group, now, reminders)),
      page: pageInfo(view, groups.length, query.pageSize),
      staleCount,
      completedCount: completed.length,
    } satisfies TodayResponse);
  }

  async pausedSeries(user: WebAuthContext, query: PageQuery): Promise<PausedSeriesResponse> {
    const { rows, total } = await this.tasks.listPausedSeriesForTelegram(user.access.workspaceId, { limit: query.pageSize, offset: query.page * query.pageSize });
    const pausedAt = await this.tasks.findSeriesPausedAt(
      user.access.workspaceId,
      rows.map((task) => task.id),
    );
    const excluded = await Promise.all(rows.map((task) => this.tasks.listRecurrenceExclusions(user.access.workspaceId, task.id)));
    const pages = Math.max(1, Math.ceil(total / query.pageSize));
    return PausedSeriesResponseSchema.parse({
      rows: rows.map((task, index) => presentPausedSeries(task, excluded[index] ?? [], pausedAt.get(task.id) ?? null)),
      page: pageInfo({ page: Math.min(query.page, pages - 1), pages }, total, query.pageSize),
    } satisfies PausedSeriesResponse);
  }

  async detail(user: WebAuthContext, id: string): Promise<TaskDetail> {
    const target = await this.resolveTarget(user, id);
    return this.buildDetail(user, target);
  }

  /**
   * What the reschedule sheet needs before it renders. `presetTimes` is the same computation the
   * card's «+1 ч / Вечером / Завтра» buttons perform, resolved here so the button can show the time
   * it will produce instead of the client re-deriving it from a timezone it does not have.
   *
   * `null` where the preset resolves to a *day* rather than a moment, which is what «завтра» means
   * for a task that has no clock time. It used to answer local midnight, so the sheet offered
   * «Завтра · 00:00» for a task the user had deliberately left untimed — and 00:00 is a real time a
   * client cannot tell from a placeholder.
   */
  async rescheduleOptions(user: WebAuthContext, id: string): Promise<RescheduleOptions> {
    const { task, occurrence } = await this.resolveTarget(user, id);
    const timezone = occurrence?.timezone ?? task.timezone;
    const reasonRequired = occurrence ? await this.tasks.isRescheduleReasonRequired(user.access.workspaceId, occurrence.id) : false;
    const presetTimes: Record<string, string | null> = {};
    for (const preset of PRESETS) {
      // A task with no occurrence has nothing to move relative to; the sheet still has to render,
      // and the preset then stands for the same clock time on the day the choice names.
      const at = occurrence ? this.presetInstant(user, task, occurrence, preset) : this.presetInstantWithoutOccurrence(user, preset, timezone);
      presetTimes[preset] = at?.toISOString() ?? null;
    }
    return RescheduleOptionsSchema.parse({
      reasonRequired,
      presets: [...PRESETS],
      presetTimes,
      timezone,
      hasSeries: Boolean(task.recurrenceRule),
    } satisfies RescheduleOptions);
  }

  /* ------------------------------------------------------------------ writes */

  async create(user: WebAuthContext, body: CreateTaskRequest): Promise<TaskMutationResponse> {
    const now = new Date();
    const timezone = body.timezone ?? user.settings.timezone;
    const goal = body.goalId ? await this.context.findGoal(user.access.workspaceId, body.goalId) : null;
    if (body.goalId && !goal) throw ApiError.notFound();
    const { goalId: _goalId, timezone: _timezone, ...taskBody } = body;
    const action: ResolvedAction = {
      type: "create_task",
      intent: "explicit",
      timezone,
      reviewTime: this.reviewTime(user, body.when, timezone, now),
      body: { ...taskBody, timezone: null },
      goal: goal ? { goalId: goal.id, goalVersion: goal.version } : null,
    };
    const groupId = await this.apply(user, [action], now, null);
    const created = await this.tasks.listTasksForActionGroup(user.access.workspaceId, groupId);
    const task = created[0];
    if (!task) throw new DomainRuleError("the created task could not be read back", "create_readback");
    return this.mutationResponse(user, await this.rowsForTask(user, task), groupId);
  }

  async update(user: WebAuthContext, id: string, body: UpdateTaskRequest): Promise<TaskMutationResponse> {
    const { task } = await this.resolveTarget(user, id);
    const action: ResolvedAction = {
      ...this.base(user, task.timezone),
      type: "update_task",
      taskId: task.id,
      taskVersion: body.expectedVersion,
      patch: {
        title: body.title,
        why: body.why,
        nextAction: body.nextAction,
        context: body.context,
        checklist: body.checklist,
        importance: body.importance,
        clear: body.clear,
      },
    };
    const groupId = await this.apply(user, [action], new Date(), task.version);
    return this.mutationResponse(user, await this.rowsForTask(user, task), groupId);
  }

  /** Ticking one box is a whole-list write, because the domain has no per-item one. */
  async checklist(user: WebAuthContext, id: string, body: ChecklistWriteRequest): Promise<TaskMutationResponse> {
    const { task } = await this.resolveTarget(user, id);
    const action: ResolvedAction = {
      ...this.base(user, task.timezone),
      type: "update_task",
      taskId: task.id,
      taskVersion: body.expectedVersion,
      patch: { title: null, why: null, nextAction: null, context: null, checklist: body.items, importance: null, clear: null },
    };
    const groupId = await this.apply(user, [action], new Date(), task.version);
    return this.mutationResponse(user, await this.rowsForTask(user, task), groupId);
  }

  async setState(user: WebAuthContext, id: string, body: OccurrenceStateRequest): Promise<TaskMutationResponse> {
    const target = await this.resolveTarget(user, id);
    if (body.state === "started" || body.state === "seen") return this.acknowledge(user, target, body);

    const now = new Date();
    const stateTarget = this.stateTarget(target, body);
    const action: ResolvedAction = {
      ...this.base(user, target.occurrence?.timezone ?? target.task.timezone),
      type: "set_task_state",
      target: stateTarget,
      state: body.state,
    };
    // A conflict answers with the version of the row the request addressed, not with whichever one
    // this task happens to have: cancelling a whole series is checked against the task.
    const currentVersion = stateTarget.kind === "occurrence" ? (target.occurrence?.version ?? target.task.version) : target.task.version;
    const groupId = await this.apply(user, [action], now, currentVersion);
    return this.mutationResponse(user, await this.rowsForTask(user, target.task), groupId);
  }

  async reschedule(user: WebAuthContext, id: string, body: RescheduleRequest): Promise<TaskMutationResponse> {
    const now = new Date();
    const target = await this.resolveTarget(user, id);
    const { task, occurrence } = target;
    const scope = body.scope ?? (occurrence ? "occurrence" : task.recurrenceRule ? "series" : null);
    if (scope === "series" && !task.recurrenceRule) throw new DomainRuleError("task is not a recurring series", "not_recurring");

    const timezone = occurrence?.timezone ?? task.timezone;
    const when = body.when.kind === "custom" ? (body.when.when as When) : this.presetWhen(user, task, occurrence, body.when.preset, timezone);
    const action: ResolvedAction = {
      ...this.base(user, timezone),
      reviewTime: this.reviewTime(user, when, timezone, now),
      type: "reschedule",
      target:
        scope === "series"
          ? { kind: "series", taskId: task.id, taskVersion: body.expectedVersion }
          : occurrence
            ? {
                kind: "occurrence",
                taskId: task.id,
                taskVersion: task.version,
                occurrenceId: occurrence.id,
                occurrenceVersion: body.expectedVersion,
                timezone: occurrence.timezone,
              }
            : { kind: "task", taskId: task.id, taskVersion: body.expectedVersion },
      when,
      recurrence: scope === "series" ? body.recurrence : null,
      reason: body.reason ? body.reason.text?.trim() || body.reason.code : null,
    };
    const groupId = await this.apply(user, [action], now, scope === "series" || !occurrence ? task.version : occurrence.version);
    return this.mutationResponse(user, await this.rowsForTask(user, task), groupId);
  }

  /**
   * Pause and resume a whole series, exactly what `series:*` does today — including the asymmetry:
   * resume materializes dates outside the journal, so undoing it would restore the paused parent
   * and leave those dates live and reminding. Pausing again is the honest way back.
   */
  async series(user: WebAuthContext, id: string, body: SeriesRequest, operation: "pause" | "resume"): Promise<TaskMutationResponse> {
    const { task } = await this.resolveTarget(user, id);
    if (!task.recurrenceRule) throw new DomainRuleError("task is not a recurring series", "not_recurring");
    if (task.version !== body.expectedVersion) throw ApiError.conflict(task.version);
    const result = await this.actions.applySeriesOperation(this.scope(user), task.id, body.expectedVersion, operation);
    const groupId = operation === "pause" ? (result.applied?.groupId ?? null) : null;
    return this.mutationResponse(user, await this.rowsForTask(user, task), groupId);
  }

  async undo(user: WebAuthContext, groupId: string): Promise<boolean> {
    await this.actions.undo(user.access.workspaceId, user.access.user.id, groupId);
    return true;
  }

  /* ----------------------------------------------------------------- helpers */

  /**
   * `started` and `seen` in one place. Neither has a `set_task_state` to journal, so the version is
   * checked here rather than being discovered as a `DomainRuleError` inside the transaction, and
   * the answer carries no `undoGroupId`: there is nothing to roll back.
   */
  private async acknowledge(user: WebAuthContext, target: TaskTargetRows, body: OccurrenceStateRequest): Promise<TaskMutationResponse> {
    const { occurrence } = target;
    if (!occurrence) throw new DomainRuleError("a task without a date has no occurrence to change", "fuzzy_no_occurrence");
    if (occurrence.version !== body.expectedVersion) throw ApiError.conflict(occurrence.version);
    await this.tasks.setOccurrenceStatus({
      workspaceId: user.access.workspaceId,
      occurrenceId: occurrence.id,
      expectedVersion: body.expectedVersion,
      nextStatus: body.state === "started" ? "in_progress" : "open",
      actorUserId: user.access.user.id,
      ...(body.note?.trim() ? { note: body.note.trim() } : {}),
    });
    return this.mutationResponse(user, await this.rowsForTask(user, target.task), null);
  }

  /**
   * The shape `set_task_state` addresses: the occurrence when there is one, the task otherwise —
   * unless a `cancelled` request said which of the three things it meant.
   *
   * «Отмени» has two answers and the request now carries which one: this date
   * (`update_occurrence` cancel, which for a one-off closes the task with it), or the whole repeat
   * (`change_series` cancel). Without the second, cancelling one occurrence of a series left the
   * rule producing the next one — a capability the domain has always had and no screen could reach.
   *
   * `expectedVersion` follows the target, which is what the contract's table spells out: the
   * occurrence version for an occurrence, the task version for a series or a dateless task.
   */
  private stateTarget(target: TaskTargetRows, body: OccurrenceStateRequest): TaskTarget {
    const { task, occurrence } = target;
    const scope = body.state === "cancelled" ? (body.scope ?? "occurrence") : "occurrence";
    if (scope === "series") {
      if (!task.recurrenceRule) throw new DomainRuleError("task is not a recurring series", "not_recurring");
      return { kind: "series", taskId: task.id, taskVersion: body.expectedVersion };
    }
    if (occurrence) {
      return {
        kind: "occurrence",
        taskId: task.id,
        taskVersion: task.version,
        occurrenceId: occurrence.id,
        occurrenceVersion: body.expectedVersion,
        timezone: occurrence.timezone,
      };
    }
    if (body.state === "skipped") throw new DomainRuleError("skip is only valid for recurring tasks", "fuzzy_no_occurrence");
    return { kind: "task", taskId: task.id, taskVersion: body.expectedVersion };
  }

  /**
   * The one write path. Validation runs first so that a stale version is the typed conflict a
   * client can render, rather than a `DomainRuleError` raised halfway through the transaction.
   */
  private async apply(user: WebAuthContext, actions: readonly ResolvedAction[], now: Date, currentVersion: number | null): Promise<string> {
    const scope = { ...this.scope(user), now };
    const issues = await this.actions.validateResolved(actions, scope);
    if (issues.length) throw errorForIssues(issues, currentVersion);
    const applied = await this.actions.applyResolved(actions, scope);
    return applied.groupId;
  }

  private scope(user: WebAuthContext): ActionScope {
    return {
      workspaceId: user.access.workspaceId,
      actorUserId: user.access.user.id,
      recipientUserId: user.access.user.id,
      language: user.locale,
    };
  }

  private base(user: WebAuthContext, timezone: string): { intent: "explicit"; timezone: string; reviewTime: string } {
    return { intent: "explicit", timezone, reviewTime: user.settings.morningReferenceTime };
  }

  /**
   * A task id or an occurrence id: the deep link the bot's launch button carries names an
   * occurrence, and the list line carries a task. Both lookups are workspace-scoped, so an id from
   * another workspace is the same not-found as an id that does not exist.
   */
  private async resolveTarget(user: WebAuthContext, id: string): Promise<TaskTargetRows> {
    const task = await this.tasks.getTask(user.access.workspaceId, id);
    if (task) return { task, occurrence: await this.tasks.findCurrentOccurrence(user.access.workspaceId, task.id, { includeElapsed: true }) };
    const context = await this.tasks.getOccurrenceContext(user.access.workspaceId, id);
    if (!context) throw ApiError.notFound();
    return { task: context.task, occurrence: context.occurrence };
  }

  /** The task as it now stands, re-read after a write so the answer is the stored row, not a guess. */
  private async rowsForTask(user: WebAuthContext, previous: TaskRow): Promise<TaskTargetRows> {
    const task = await this.tasks.getTask(user.access.workspaceId, previous.id);
    if (!task) throw ApiError.notFound();
    return { task, occurrence: await this.tasks.findCurrentOccurrence(user.access.workspaceId, task.id, { includeElapsed: true }) };
  }

  private async mutationResponse(user: WebAuthContext, target: TaskTargetRows, undoGroupId: string | null): Promise<TaskMutationResponse> {
    return TaskMutationResponseSchema.parse({ task: await this.buildDetail(user, target), undoGroupId } satisfies TaskMutationResponse);
  }

  private async buildDetail(user: WebAuthContext, target: TaskTargetRows): Promise<TaskDetail> {
    const now = new Date();
    const { workspaceId } = user.access;
    const { task, occurrence } = target;
    const [excludedLocalDates, checklistByTask, goal, siblings, journal, reminders, nextReminderAt, reasonRequired] = await Promise.all([
      this.tasks.listRecurrenceExclusions(workspaceId, task.id),
      this.tasks.listChecklistsForContext(workspaceId, [task.id]),
      this.context.findGoalForTask(workspaceId, task.id),
      this.tasks.listOccurrencesForTask(workspaceId, task.id),
      this.tasks.listTaskEvents(workspaceId, task.id),
      this.tasks.listTaskReminders(workspaceId, task.id),
      occurrence ? this.reminders.nextUserReminderAt(workspaceId, occurrence.id) : Promise.resolve(null),
      occurrence ? this.tasks.isRescheduleReasonRequired(workspaceId, occurrence.id) : Promise.resolve(false),
    ]);

    return TaskDetailSchema.parse({
      id: task.id,
      version: task.version,
      title: task.title,
      why: task.why ?? null,
      nextAction: task.nextAction ?? null,
      context: task.context ?? null,
      kind: task.kind,
      importance: task.importance,
      status: task.status,
      timeMode: task.timeMode,
      timezone: task.timezone,
      occurrence: occurrence ? presentOccurrenceDetail(occurrence, now) : null,
      fuzzy: presentFuzzy(task),
      recurrence: presentRecurrence(task, excludedLocalDates),
      siblingOccurrences: siblings
        .filter((row) => row.id !== occurrence?.id && isLiveOccurrence(row))
        .map((row) => OccurrenceDetailSchema.parse(presentOccurrenceDetail(row, now))),
      checklist: presentChecklist(checklistByTask.get(task.id) ?? []),
      goal: presentGoalLink(goal),
      reminders: presentReminders(reminders),
      nextReminderAt: nextReminderAt ? nextReminderAt.toISOString() : null,
      journal: presentJournal(journal, user.access.user.id),
      rescheduleReasonRequired: reasonRequired,
      pickedWeekStart: task.pickedWeekStart ?? null,
      // Pausing a series that already ends only loses the dates between here and its end, so the
      // offer is made for an endless repeat and for nothing else.
      canPauseSeries: Boolean(task.recurrenceRule) && !task.recurrenceEndLocalDate && task.status === "active",
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    } satisfies TaskDetail);
  }

  private async remindersForGroups(user: WebAuthContext, groups: ReadonlyArray<{ rows: ReadonlyArray<{ occurrence: OccurrenceRow | null }> }>): Promise<Map<string, Date>> {
    const ids = groups.flatMap((group) => group.rows.flatMap((row) => (row.occurrence ? [row.occurrence.id] : [])));
    if (!ids.length) return new Map();
    return this.reminders.nextUserReminderAtMany(user.access.workspaceId, ids);
  }

  private presetWhen(user: WebAuthContext, task: TaskRow, occurrence: OccurrenceRow | null, preset: ReschedulePreset, timezone: string): When {
    if (!occurrence) throw new DomainRuleError("a task without a date has no time to move by a preset", "fuzzy_no_occurrence");
    const fields = quickRescheduleSchedule({
      choice: preset as QuickRescheduleChoice,
      timeMode: task.timeMode,
      occurrence,
      now: new Date(),
      morningReferenceTime: user.settings.morningReferenceTime,
      eveningReferenceTime: user.settings.eveningReferenceTime,
    });
    return whenFromRescheduleFields(fields, timezone);
  }

  /**
   * What a preset resolves to right now, or `null` when it lands on a day with no clock time —
   * a day has no instant, and midnight is a real time the client could not tell from a placeholder.
   */
  private presetInstant(user: WebAuthContext, task: TaskRow, occurrence: OccurrenceRow, preset: ReschedulePreset): Date | null {
    const fields = quickRescheduleSchedule({
      choice: preset as QuickRescheduleChoice,
      timeMode: task.timeMode,
      occurrence,
      now: new Date(),
      morningReferenceTime: user.settings.morningReferenceTime,
      eveningReferenceTime: user.settings.eveningReferenceTime,
    });
    // A date-only result — `plannedLocalDate` or `dueLocalDate` with no instant — is a day, and
    // there is no honest instant to name for it.
    return fields.plannedStartAt ?? fields.dueAt ?? null;
  }

  private presetInstantWithoutOccurrence(user: WebAuthContext, preset: ReschedulePreset, timezone: string): Date {
    const now = new Date();
    if (preset === "1h") return new Date(now.getTime() + 60 * 60_000);
    const today = localDateAt(now, timezone);
    if (preset === "evening") {
      const at = localDateAndTimeToUtc(today, user.settings.eveningReferenceTime, timezone).date;
      return at > now ? at : localDateAndTimeToUtc(shiftLocalDate(today, 1), user.settings.eveningReferenceTime, timezone).date;
    }
    return localDateAndTimeToUtc(shiftLocalDate(today, 1), user.settings.morningReferenceTime, timezone).date;
  }

  /**
   * The planning checkpoint of a fuzzy task, mirroring `reviewTimeFor` in `action-resolver.ts`: the
   * server picks the time, so it must not pick one already gone today and then blame the caller for
   * a schedule in the past.
   */
  private reviewTime(user: WebAuthContext, when: When, timezone: string, now: Date): string {
    const morning = user.settings.morningReferenceTime;
    if (when.mode !== "fuzzy" || when.reviewDate !== localDateAt(now, timezone)) return morning;
    const parts = localDateTimeAt(now, timezone);
    const nowMinutes = parts.hour * 60 + parts.minute;
    const [refHour = 9, refMinute = 0] = morning.split(":").map(Number);
    if (refHour * 60 + refMinute > nowMinutes) return morning;
    const soon = Math.ceil((nowMinutes + 60) / 15) * 15;
    if (soon >= 24 * 60) return morning;
    return `${String(Math.floor(soon / 60)).padStart(2, "0")}:${String(soon % 60).padStart(2, "0")}`;
  }
}
