import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { planReminders, type ReminderRuleSpec } from "../core/reminder-planning.js";
import { buildOneTimeOccurrence, buildRecurringOccurrences, type OccurrenceProjection } from "../core/recurrence.js";
import { validateOccurrenceTransition } from "../core/occurrence.js";
import { isRescheduleReasonRequired, validateNewTaskTiming, validateTaskDefinition } from "../core/task-policy.js";
import { localDateAt } from "../core/timezone.js";
import { occurrenceFallsOnLocalDate } from "../core/local-schedule.js";
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

  async listForTelegram(workspaceId: string, limit = 12) {
    const [actionable, fuzzy] = await Promise.all([
      // A recurrence is materialized as many occurrences. Fetch the full active
      // set before choosing one representative per task, otherwise a daily series
      // can consume the whole page and hide unrelated tasks.
      this.repository.listActionableForTelegram(workspaceId),
      this.repository.listFuzzyForTelegram(workspaceId, Math.max(limit, 20)),
    ]);
    const rows = [...actionable, ...fuzzy.map((task) => ({ task, occurrence: null }))].sort(compareTelegramTasks);
    const seenTaskIds = new Set<string>();
    return rows
      .filter((row) => {
        if (seenTaskIds.has(row.task.id)) return false;
        seenTaskIds.add(row.task.id);
        return true;
      })
      .slice(0, limit);
  }

  async listTodayForTelegram(workspaceId: string, localDate: string, limit = 20) {
    // Filter by the requested day before applying the display limit. This keeps
    // every occurrence on that day discoverable even when other series have many
    // materialized future occurrences.
    const [actionable, fuzzy] = await Promise.all([
      this.repository.listActionableForTelegram(workspaceId),
      this.repository.listFuzzyReviewsForLocalDate(workspaceId, localDate, limit),
    ]);
    const rows = actionable.filter(({ task, occurrence }) => occurrenceFallsOnLocalDate({ ...occurrence, timeMode: task.timeMode }, localDate));
    const reviews = fuzzy.map((task) => ({ task, occurrence: null }));
    return [...rows, ...reviews].sort(compareTelegramTasks).slice(0, limit);
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

  async recordInteraction(input: { workspaceId: string; occurrenceId: string; actorUserId: string; eventType: "occurrence:seen" | "occurrence:cant_start" }): Promise<void> {
    const occurrence = await this.repository.findOccurrence(input.workspaceId, input.occurrenceId);
    if (!occurrence) throw new DomainRuleError("occurrence not found");
    await this.repository.recordEvent({
      workspaceId: input.workspaceId,
      taskId: occurrence.taskId,
      occurrenceId: occurrence.id,
      actorUserId: input.actorUserId,
      eventType: input.eventType,
    });
  }

  async recordBlocker(input: { workspaceId: string; occurrenceId: string; actorUserId: string; details: string }): Promise<void> {
    const occurrence = await this.repository.findOccurrence(input.workspaceId, input.occurrenceId);
    if (!occurrence) throw new DomainRuleError("occurrence not found");
    const details = input.details.trim();
    if (!details) throw new DomainRuleError("blocker cannot be empty");
    await this.repository.recordEvent({
      workspaceId: input.workspaceId,
      taskId: occurrence.taskId,
      occurrenceId: occurrence.id,
      actorUserId: input.actorUserId,
      eventType: "occurrence:blocker",
      details,
    });
  }

  /** Detail fields for a Telegram task card that are not on the task row itself. */
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

function compareTelegramTasks(
  left: { task: typeof tasks.$inferSelect; occurrence: typeof taskOccurrences.$inferSelect | null },
  right: { task: typeof tasks.$inferSelect; occurrence: typeof taskOccurrences.$inferSelect | null },
): number {
  const importance = (value: (typeof tasks.$inferSelect)["importance"]) => (value === "critical" ? 0 : value === "required" ? 1 : 2);
  const leftImportance = importance(left.task.importance);
  const rightImportance = importance(right.task.importance);
  if (leftImportance !== rightImportance) return leftImportance - rightImportance;
  const leftState = left.occurrence?.overdue ? 0 : left.occurrence?.status === "in_progress" ? 1 : 2;
  const rightState = right.occurrence?.overdue ? 0 : right.occurrence?.status === "in_progress" ? 1 : 2;
  if (leftState !== rightState) return leftState - rightState;
  return telegramTaskTime(left) - telegramTaskTime(right);
}

function telegramTaskTime(row: { task: typeof tasks.$inferSelect; occurrence: typeof taskOccurrences.$inferSelect | null }): number {
  const value = row.occurrence?.dueAt ?? row.occurrence?.plannedStartAt ?? row.task.reviewAt;
  return value ? new Date(value).getTime() : Number.POSITIVE_INFINITY;
}

export { withExplicitReminder };
