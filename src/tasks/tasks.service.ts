import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { planReminders, type ReminderRuleSpec } from "../core/reminder-planning.js";
import { buildOneTimeOccurrence, buildRecurringOccurrences, type OccurrenceProjection } from "../core/recurrence.js";
import { validateOccurrenceTransition } from "../core/occurrence.js";
import { isRescheduleReasonRequired, validateNewTaskTiming, validateTaskDefinition } from "../core/task-policy.js";
import { localDateAt } from "../core/timezone.js";
import { comparePoolRows, currentWeekStart, isPickLive, previousWeekRange, WEEK_PICK_LIMIT } from "../core/week-plan.js";
import { occurrenceFallsOnLocalDate } from "../core/local-schedule.js";
import { filterByScope, groupTaskRows, isStaleRow, scopeCounts, type TaskGroup, type TaskScope } from "../core/task-list-view.js";
import type { OccurrenceScheduleView } from "../core/time-presentation.js";
import type { TaskDefinition } from "../core/types.js";
import type { reminderDeliveries, taskChecklistItems, taskOccurrences, taskRecurrenceExclusions, tasks } from "../database/schema.js";
import { ReminderQueueService } from "../reminders/reminder-queue.service.js";
import { TasksRepository, type PersistedTaskPlan } from "./tasks.repository.js";
import { defaultReminderRuleSpecs, reminderRuleRows, withExplicitReminder } from "./task-plan-rules.js";
import { reminderSettingsFromRow } from "./task-record-mappers.js";
import { RecurrenceMaintenanceService } from "./recurrence-maintenance.service.js";
import { safeError } from "../observability/safe-error.js";
import { DomainRuleError } from "../core/errors.js";
import { logger } from "../observability/logger.js";

export interface CreateTaskInput {
  workspaceId: string;
  actorUserId: string;
  recipientUserId: string;
  sourceActionGroupId?: string;
  title: string;
  definition: TaskDefinition;
  why?: string;
  nextAction?: string;
  context?: string;
  checklist?: Array<{ text: string; done: boolean }>;
  /** User-requested reminder; replaces the default user reminder, keeps follow-up/review rules. */
  explicitReminder?: ReminderRuleSpec;
  now?: Date;
}

export interface CreatedTaskResult {
  taskId: string;
  occurrenceIds: string[];
  deliveryIds: string[];
  reminderSchedules: Array<{ scheduledFor: Date; purpose: "user_reminder" | "follow_up" | "planning_review" }>;
  occurrenceSchedule?: OccurrenceScheduleView;
}

export interface BuiltTaskPlan {
  plan: PersistedTaskPlan;
  result: CreatedTaskResult;
}

/** One line a list screen can show: a live occurrence, or a fuzzy task that has none. */
export type TelegramScreenRow = { task: typeof tasks.$inferSelect; occurrence: typeof taskOccurrences.$inferSelect | null };

export type TelegramTaskGroup = TaskGroup<TelegramScreenRow>;

@Injectable()
export class TasksService {
  constructor(
    private readonly repository: TasksRepository,
    private readonly reminderQueue: ReminderQueueService,
    private readonly recurrenceMaintenance: RecurrenceMaintenanceService,
  ) {}

  async createTask(input: CreateTaskInput): Promise<CreatedTaskResult> {
    const [result] = await this.createTasks([input]);
    if (!result) throw new Error("task was not created");
    return result;
  }

  async createTasks(inputs: readonly CreateTaskInput[]): Promise<CreatedTaskResult[]> {
    const built = await this.prepareTaskPlans(inputs);
    await this.repository.createPlans(built.map((item) => item.plan));
    await this.enqueuePreparedTaskPlans(built);
    return built.map((item) => item.result);
  }

  async prepareTaskPlans(inputs: readonly CreateTaskInput[]): Promise<BuiltTaskPlan[]> {
    const built: BuiltTaskPlan[] = [];
    for (const input of inputs) built.push(await this.buildTaskPlan(input));
    return built;
  }

  async enqueuePreparedTaskPlans(built: readonly BuiltTaskPlan[]): Promise<void> {
    for (const item of built) {
      for (const delivery of item.plan.reminderDeliveries) {
        if (delivery.status !== "pending" || !delivery.id) continue;
        try {
          await this.reminderQueue.enqueue(delivery.id, delivery.scheduledFor);
        } catch (error) {
          logger.error("failed to enqueue reminder; queue reconciliation will retry", { deliveryId: delivery.id, error: safeError(error) });
        }
      }
    }
  }

  private async buildTaskPlan(input: CreateTaskInput): Promise<BuiltTaskPlan> {
    const title = input.title.trim();
    if (!title) throw new DomainRuleError("task title is required");
    if (title.length > 500) throw new DomainRuleError("task title must be at most 500 characters");
    const validation = validateTaskDefinition(input.definition);
    if (!validation.ok) throw new Error(validation.errors.join("; "));

    const settingsRow = await this.repository.findMemberSettings(input.workspaceId, input.recipientUserId);
    if (!settingsRow) throw new DomainRuleError("recipient is not a workspace member");
    const settings = reminderSettingsFromRow(settingsRow);

    const now = input.now ?? new Date();
    const taskId = randomUUID();
    const definition = input.definition;
    const timingErrors = validateNewTaskTiming(definition, now);
    if (timingErrors.length) throw new Error(timingErrors.join("; "));
    const projections = definition.recurrenceRule
      ? buildRecurringOccurrences(definition, now)
      : [buildOneTimeOccurrence(definition, now)].filter((value): value is OccurrenceProjection => value !== null);

    const ruleSpecs = defaultReminderRuleSpecs(definition, settingsRow, input.explicitReminder);
    const ruleIds = ruleSpecs.map(() => randomUUID());
    const occurrenceIds = projections.map(() => randomUUID());

    const taskRow: PersistedTaskPlan["task"] = {
      id: taskId,
      workspaceId: input.workspaceId,
      createdByUserId: input.actorUserId,
      ...(input.sourceActionGroupId ? { sourceActionGroupId: input.sourceActionGroupId } : {}),
      title,
      ...(input.why?.trim() ? { why: input.why.trim() } : {}),
      ...(input.nextAction?.trim() ? { nextAction: input.nextAction.trim() } : {}),
      ...(input.context?.trim() ? { context: input.context.trim() } : {}),
      kind: definition.kind,
      importance: definition.importance,
      status: "active",
      timeMode: definition.timeMode,
      timezone: definition.timezone,
      ...(definition.plannedStartAt ? { plannedStartAt: definition.plannedStartAt } : {}),
      ...(definition.plannedEndAt ? { plannedEndAt: definition.plannedEndAt } : {}),
      ...(definition.plannedLocalDate ? { plannedLocalDate: definition.plannedLocalDate } : {}),
      ...(definition.dueAt ? { dueAt: definition.dueAt } : {}),
      ...(definition.dueLocalDate ? { dueLocalDate: definition.dueLocalDate } : {}),
      ...(definition.fuzzyHorizonText ? { fuzzyHorizonText: definition.fuzzyHorizonText } : {}),
      ...(definition.reviewAt ? { reviewAt: definition.reviewAt } : {}),
      ...(definition.recurrenceRule ? { recurrenceRule: definition.recurrenceRule } : {}),
      ...(definition.recurrenceTimezone ? { recurrenceTimezone: definition.recurrenceTimezone } : {}),
      ...(definition.recurrenceEndLocalDate ? { recurrenceEndLocalDate: definition.recurrenceEndLocalDate } : {}),
      ...(definition.missPolicy ? { missPolicy: definition.missPolicy } : {}),
      ...(definition.habitMode !== undefined ? { habitMode: definition.habitMode } : {}),
      ...(definition.minimumAction ? { minimumAction: definition.minimumAction } : {}),
      ...(definition.desiredAction ? { desiredAction: definition.desiredAction } : {}),
      ...(definition.habitTrigger ? { habitTrigger: definition.habitTrigger } : {}),
    };

    const occurrenceRows: Array<typeof taskOccurrences.$inferInsert> = projections.map((projection, index) => ({
      id: occurrenceIds[index],
      workspaceId: input.workspaceId,
      taskId,
      ...(projection.recurrenceKey ? { recurrenceKey: projection.recurrenceKey } : {}),
      seriesRevision: 1,
      status: projection.status,
      timezone: projection.timezone,
      ...(projection.plannedStartAt ? { plannedStartAt: projection.plannedStartAt } : {}),
      ...(projection.plannedEndAt ? { plannedEndAt: projection.plannedEndAt } : {}),
      ...(projection.plannedLocalDate ? { plannedLocalDate: projection.plannedLocalDate } : {}),
      ...(projection.dueAt ? { dueAt: projection.dueAt } : {}),
      ...(projection.dueLocalDate ? { dueLocalDate: projection.dueLocalDate } : {}),
      ...(projection.expiresAt ? { expiresAt: projection.expiresAt } : {}),
      dstAdjusted: projection.dstAdjusted ?? false,
    }));
    const checklistRows: Array<typeof taskChecklistItems.$inferInsert> = (input.checklist ?? []).map((item, index) => ({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      taskId,
      text: item.text.trim(),
      sortOrder: index,
      done: item.done,
    }));
    const recurrenceExclusionRows: Array<typeof taskRecurrenceExclusions.$inferInsert> = (definition.recurrenceExcludedLocalDates ?? []).map((localDate) => ({
      workspaceId: input.workspaceId,
      taskId,
      localDate,
    }));

    const ruleRows = reminderRuleRows({ workspaceId: input.workspaceId, taskId, specs: ruleSpecs, ruleIds });

    const deliveryRows: Array<typeof reminderDeliveries.$inferInsert> = [];
    const deliveryIds: string[] = [];
    const targets: Array<{ occurrence: OccurrenceProjection | null; occurrenceId?: string }> = projections.length
      ? projections.map((occurrence, index) => {
          const occurrenceId = occurrenceIds[index];
          return { occurrence, ...(occurrenceId ? { occurrenceId } : {}) };
        })
      : [{ occurrence: null }];

    for (const target of targets) {
      const plans = planReminders({ task: definition, occurrence: target.occurrence, rules: ruleSpecs, settings, now });
      for (const plan of plans) {
        const reminderRuleId = ruleIds[plan.ruleIndex];
        if (!reminderRuleId) throw new Error("reminder rule index is invalid");
        const id = randomUUID();
        deliveryIds.push(id);
        deliveryRows.push({
          id,
          workspaceId: input.workspaceId,
          recipientUserId: input.recipientUserId,
          reminderRuleId,
          taskId,
          ...(target.occurrenceId ? { occurrenceId: target.occurrenceId } : {}),
          intendedFor: plan.intendedFor,
          scheduledFor: plan.scheduledFor,
          status: plan.suppressedReason ? "suppressed" : "pending",
          ...(plan.suppressedReason ? { suppressedReason: plan.suppressedReason } : {}),
          deduplicationKey: `${reminderRuleId}:${target.occurrenceId ?? "task"}:${plan.intendedFor.toISOString()}`,
        });
      }
    }

    return {
      plan: {
        task: taskRow,
        occurrences: occurrenceRows,
        reminderRules: ruleRows,
        reminderDeliveries: deliveryRows,
        checklist: checklistRows,
        recurrenceExclusions: recurrenceExclusionRows,
      },
      result: {
        taskId,
        occurrenceIds,
        deliveryIds,
        reminderSchedules: deliveryRows
          .filter((delivery) => delivery.status === "pending")
          .map((delivery) => ({
            scheduledFor: delivery.scheduledFor,
            purpose: ruleSpecs.find((_rule, index) => ruleIds[index] === delivery.reminderRuleId)?.purpose ?? "user_reminder",
          })),
        ...(occurrenceRows[0]
          ? {
              occurrenceSchedule: {
                timezone: occurrenceRows[0].timezone,
                plannedStartAt: occurrenceRows[0].plannedStartAt ?? null,
                plannedEndAt: occurrenceRows[0].plannedEndAt ?? null,
                plannedLocalDate: occurrenceRows[0].plannedLocalDate ?? null,
                dueAt: occurrenceRows[0].dueAt ?? null,
                dueLocalDate: occurrenceRows[0].dueLocalDate ?? null,
              },
            }
          : {}),
      },
    };
  }

  /**
   * Every row a list screen can show: one query for live occurrences, one for fuzzy tasks.
   * A recurrence is materialized as many occurrences, so the full set is fetched and the
   * narrowing happens above — a daily series must not be able to consume the whole page.
   */
  async listScreenRows(workspaceId: string): Promise<TelegramScreenRow[]> {
    const [actionable, fuzzy] = await Promise.all([this.repository.listActionableForTelegram(workspaceId), this.repository.listFuzzyForTelegram(workspaceId, 50)]);
    return [...actionable, ...fuzzy.map((task) => ({ task, occurrence: null }))];
  }

  /** The task list for one filter: groups in reading order, plus what every other filter would show. */
  async listGroupedForTelegram(workspaceId: string, input: { scope: TaskScope; localDate: string }) {
    const [rows, pausedCount] = await Promise.all([this.listScreenRows(workspaceId), this.repository.countPausedSeries(workspaceId)]);
    const groups = groupTaskRows(filterByScope(rows, input.scope, input.localDate), input.localDate);
    return { groups, counts: scopeCounts(rows, input.localDate), total: groups.length, pausedCount };
  }

  /**
   * The week screen: the pool ordered so that a pick left over from last week comes first, the count
   * of everything in the pool, and what the past week actually did.
   */
  async listWeekPlanForTelegram(workspaceId: string, todayLocalDate: string) {
    const [rows, total] = await Promise.all([this.repository.listPoolForTelegram(workspaceId), this.repository.countPool(workspaceId)]);
    const summary = await this.repository.summariseWeek(workspaceId, previousWeekRange(todayLocalDate));
    return { rows: [...rows].sort(comparePoolRows(todayLocalDate)), total, summary, weekStart: currentWeekStart(todayLocalDate) };
  }

  /** Tasks taken for the week today belongs to and still without a day. */
  async listPickedForWeek(workspaceId: string, todayLocalDate: string) {
    return this.repository.listPickedForWeek(workspaceId, currentWeekStart(todayLocalDate));
  }

  /**
   * Takes a task into the week or puts it back. Returns null when the task is gone or no longer in
   * the pool, and false when the week is full.
   */
  async togglePickedForWeek(workspaceId: string, taskId: string, todayLocalDate: string, now = new Date()): Promise<"picked" | "released" | "full" | null> {
    const task = await this.repository.findTask(workspaceId, taskId);
    if (!task || task.status !== "active" || task.timeMode !== "fuzzy") return null;
    const weekStart = currentWeekStart(todayLocalDate);
    if (isPickLive(task.pickedWeekStart, todayLocalDate)) {
      return (await this.repository.setPickedWeek(workspaceId, taskId, null, now)) ? "released" : null;
    }
    const picked = await this.repository.listPickedForWeek(workspaceId, weekStart, WEEK_PICK_LIMIT + 1);
    if (picked.length >= WEEK_PICK_LIMIT) return "full";
    return (await this.repository.setPickedWeek(workspaceId, taskId, weekStart, now)) ? "picked" : null;
  }

  /** One page of paused series, the one list where they are visible at all, plus how many there are. */
  async listPausedSeriesForTelegram(workspaceId: string, input: { limit: number; offset?: number }) {
    const [rows, total] = await Promise.all([this.repository.listPausedSeriesForTelegram(workspaceId, input), this.repository.countPausedSeries(workspaceId)]);
    return { rows, total };
  }

  /**
   * Today is the requested day only. Work dated before it is counted, not listed: an occurrence
   * stays overdue until it is closed, and three weeks of unclosed work used to bury the day.
   */
  async listTodayGroupedForTelegram(workspaceId: string, localDate: string) {
    const [actionable, fuzzy] = await Promise.all([
      this.repository.listActionableForTelegram(workspaceId),
      this.repository.listFuzzyReviewsForLocalDate(workspaceId, localDate, 20),
    ]);
    // `overdue: false` asks the plain question "does this occurrence cover the day": the flag itself
    // answers yes for every day, which is what used to keep three-week-old work on the Today screen.
    const coversToday = (row: (typeof actionable)[number]) => occurrenceFallsOnLocalDate({ ...row.occurrence, overdue: false, timeMode: row.task.timeMode }, localDate);
    const today = actionable.filter(coversToday);
    const reviews = fuzzy.map((task) => ({ task, occurrence: null }));
    const stale = actionable.filter((row) => isStaleRow(row, localDate) && !coversToday(row));
    return {
      groups: groupTaskRows([...today, ...reviews], localDate),
      staleCount: groupTaskRows(stale, localDate).length,
    };
  }

  async listCompletedTodayForTelegram(workspaceId: string, localDate: string) {
    const rows = await this.repository.listRecentlyCompletedForTelegram(workspaceId);
    return rows.filter(({ occurrence }) => occurrence.completedAt && localDateAt(occurrence.completedAt, occurrence.timezone) === localDate);
  }

  /**
   * Raw rows for the per-turn model context: every active or paused task, their live
   * occurrences and checklists, and the ids matching the message text. Selection, short
   * ids and formatting are the pure context layer's job (`src/core/turn-context.ts`).
   */
  async listTasksForContext(workspaceId: string, query: string) {
    const searchText = query.trim();
    const [taskRows, matches] = await Promise.all([
      this.repository.listActiveTasksForAi(workspaceId),
      searchText ? this.repository.searchActiveTasks(workspaceId, searchText, 20) : Promise.resolve([] as Array<{ id: string }>),
    ]);
    // A task the search found may sit outside the retrieval cap; it must still be addressable.
    const known = new Set(taskRows.map((task) => task.id));
    const allTasks = [...taskRows, ...matches.filter((task) => !known.has(task.id)).map((task) => task as (typeof taskRows)[number])];
    const occurrenceRows = await this.repository.listActiveOccurrencesForTasks(
      workspaceId,
      allTasks.map((task) => task.id),
    );
    const occurrencesByTask = new Map<string, typeof occurrenceRows>();
    for (const occurrence of occurrenceRows) {
      const list = occurrencesByTask.get(occurrence.taskId) ?? [];
      list.push(occurrence);
      occurrencesByTask.set(occurrence.taskId, list);
    }
    return { tasks: allTasks, occurrencesByTask, ftsMatchIds: new Set(matches.map((task) => task.id)) };
  }

  /** Checklist rows for the tasks the model will actually see. */
  async listChecklistsForContext(workspaceId: string, taskIds: readonly string[]) {
    const checklistRows = await this.repository.listChecklistForTasks(workspaceId, taskIds);
    const checklistByTask = new Map<string, typeof checklistRows>();
    for (const item of checklistRows) {
      const list = checklistByTask.get(item.taskId) ?? [];
      list.push(item);
      checklistByTask.set(item.taskId, list);
    }
    return checklistByTask;
  }

  async getTask(workspaceId: string, taskId: string) {
    return this.repository.findTask(workspaceId, taskId);
  }

  countActiveCritical(workspaceId: string): Promise<number> {
    return this.repository.countActiveCritical(workspaceId);
  }

  markHabitOfferSent(workspaceId: string, taskId: string, now = new Date()): Promise<boolean> {
    return this.repository.markHabitOfferSent(workspaceId, taskId, now);
  }

  reconcileRecurringTask(workspaceId: string, taskId: string, now = new Date()): Promise<void> {
    return this.recurrenceMaintenance.reconcileTask(workspaceId, taskId, now);
  }

  countOccurrenceEvents(workspaceId: string, occurrenceId: string, eventType: string): Promise<number> {
    return this.repository.countOccurrenceEvents(workspaceId, occurrenceId, eventType);
  }

  async isRescheduleReasonRequired(workspaceId: string, occurrenceId: string): Promise<boolean> {
    const context = await this.getOccurrenceContext(workspaceId, occurrenceId);
    if (!context) throw new DomainRuleError("occurrence not found");
    const previous = await this.repository.countReschedules(workspaceId, occurrenceId);
    return isRescheduleReasonRequired(context.task.importance, previous);
  }

  async setOccurrenceStatus(input: {
    workspaceId: string;
    occurrenceId: string;
    expectedVersion: number;
    nextStatus: "scheduled" | "open" | "in_progress" | "done" | "skipped" | "cancelled" | "elapsed";
    actorUserId?: string;
    now?: Date;
    eventElapseGraceMinutes?: number;
    systemExpire?: boolean;
  }) {
    const occurrence = await this.repository.findOccurrence(input.workspaceId, input.occurrenceId);
    if (!occurrence) throw new DomainRuleError("occurrence not found");
    const task = await this.repository.findTask(input.workspaceId, occurrence.taskId);
    if (!task) throw new DomainRuleError("task not found");

    const now = input.now ?? new Date();
    const result = validateOccurrenceTransition(occurrence.status, input.nextStatus, {
      kind: task.kind,
      recurring: Boolean(task.recurrenceRule),
      now,
      ...(occurrence.plannedStartAt ? { plannedStartAt: occurrence.plannedStartAt } : {}),
      ...(occurrence.plannedEndAt ? { plannedEndAt: occurrence.plannedEndAt } : {}),
      eventElapseGraceMinutes: input.eventElapseGraceMinutes ?? 15,
      explicitUserAction: Boolean(input.actorUserId),
      systemExpire: input.systemExpire ?? false,
    });
    if (!result.ok) throw new DomainRuleError(result.reason);

    const patch: Partial<typeof taskOccurrences.$inferInsert> = {};
    if (input.nextStatus === "done") {
      patch.completedAt = now;
      patch.completedLate = occurrence.status === "elapsed";
    }
    if (input.nextStatus === "elapsed") patch.elapsedAt = now;
    if (input.nextStatus === "skipped" && input.systemExpire) patch.skipReason = "expired";

    let nextTaskStatus: "closed" | "cancelled" | undefined;
    if (!task.recurrenceRule) {
      if (input.nextStatus === "done" || (task.kind === "event" && input.nextStatus === "elapsed")) nextTaskStatus = "closed";
      if (input.nextStatus === "cancelled") nextTaskStatus = "cancelled";
    }

    return this.repository.transitionOccurrence({
      workspaceId: input.workspaceId,
      occurrenceId: input.occurrenceId,
      expectedVersion: input.expectedVersion,
      expectedTaskVersion: task.version,
      nextStatus: input.nextStatus,
      ...(nextTaskStatus ? { nextTaskStatus } : {}),
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
      eventType: `occurrence:${input.nextStatus}`,
      patch,
    });
  }

  async getTaskCardExtras(workspaceId: string, taskId: string): Promise<{ checklist: Array<{ text: string; done: boolean }>; goalTitle: string | null }> {
    const [checklist, goalTitle] = await Promise.all([this.repository.listChecklistForTasks(workspaceId, [taskId]), this.repository.findGoalTitleForTask(workspaceId, taskId)]);
    return { checklist: checklist.map((item) => ({ text: item.text, done: item.done })), goalTitle };
  }

  /** The occurrence an action on this task addresses; null for a task with no live occurrence. */
  findCurrentOccurrence(workspaceId: string, taskId: string, opts: { includeElapsed?: boolean } = {}) {
    return this.repository.findCurrentOccurrence(workspaceId, taskId, opts);
  }

  findCurrentOccurrences(workspaceId: string, taskIds: readonly string[]) {
    return this.repository.findCurrentOccurrences(workspaceId, taskIds);
  }

  async getOccurrenceContext(workspaceId: string, occurrenceId: string) {
    const occurrence = await this.repository.findOccurrence(workspaceId, occurrenceId);
    if (!occurrence) return null;
    const task = await this.repository.findTask(workspaceId, occurrence.taskId);
    return task ? { task, occurrence } : null;
  }
}

export { withExplicitReminder };
