import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { defaultReminderTemplates } from "../core/reminder-defaults.js";
import { defaultRuleSpecs, planReminders, type ReminderRuleSpec, type ReminderSettings } from "../core/reminder-planning.js";
import { buildOneTimeOccurrence, buildRecurringOccurrences, type OccurrenceProjection } from "../core/recurrence.js";
import { validateOccurrenceTransition } from "../core/occurrence.js";
import { isRescheduleReasonRequired, validateNewTaskTiming, validateTaskDefinition } from "../core/task-policy.js";
import { localDateAt } from "../core/timezone.js";
import type { OccurrenceScheduleView } from "../core/time-presentation.js";
import type { TaskDefinition } from "../core/types.js";
import type { reminderDeliveries, reminderRules, taskChecklistItems, taskOccurrences, taskRecurrenceExclusions, tasks } from "../database/schema.js";
import { ReminderQueueService } from "../reminders/reminder-queue.service.js";
import { TasksRepository, type PersistedTaskPlan } from "./tasks.repository.js";
import { RecurrenceMaintenanceService } from "./recurrence-maintenance.service.js";
import { safeError } from "../observability/safe-error.js";

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
          console.error("failed to enqueue reminder; queue reconciliation will retry", { deliveryId: delivery.id, error: safeError(error) });
        }
      }
    }
  }

  async undoCreatedTasks(workspaceId: string, tasksToDelete: readonly { id: string; version: number }[]): Promise<void> {
    await this.repository.deleteTasksIfVersions(workspaceId, tasksToDelete);
  }

  private async buildTaskPlan(input: CreateTaskInput): Promise<BuiltTaskPlan> {
    const title = input.title.trim();
    if (!title) throw new Error("task title is required");
    if (title.length > 500) throw new Error("task title must be at most 500 characters");
    const validation = validateTaskDefinition(input.definition);
    if (!validation.ok) throw new Error(validation.errors.join("; "));

    const settingsRow = await this.repository.findMemberSettings(input.workspaceId, input.recipientUserId);
    if (!settingsRow) throw new Error("recipient is not a workspace member");
    const settings: ReminderSettings = {
      notificationTimezone: settingsRow.quietHoursTimezone,
      quietHours: {
        enabled: settingsRow.quietHoursEnabled,
        weekday: { start: settingsRow.weekdayQuietStart, end: settingsRow.weekdayQuietEnd },
        weekend: { start: settingsRow.weekendQuietStart, end: settingsRow.weekendQuietEnd },
      },
      ...(settingsRow.notificationsSnoozedUntil ? { notificationsSnoozedUntil: settingsRow.notificationsSnoozedUntil } : {}),
      morningReferenceTime: settingsRow.morningReferenceTime,
      eveningReferenceTime: settingsRow.eveningReferenceTime,
    };

    const now = input.now ?? new Date();
    const taskId = randomUUID();
    const definition = input.definition;
    const timingErrors = validateNewTaskTiming(definition, now);
    if (timingErrors.length) throw new Error(timingErrors.join("; "));
    const projections = definition.recurrenceRule
      ? buildRecurringOccurrences(definition, now)
      : [buildOneTimeOccurrence(definition, now)].filter((value): value is OccurrenceProjection => value !== null);

    const eventOffsetsMinutes = Array.isArray(settingsRow.eventReminderOffsetsMinutes)
      ? settingsRow.eventReminderOffsetsMinutes.filter((value): value is number => Number.isInteger(value))
      : undefined;
    const templates = defaultReminderTemplates({
      kind: definition.kind,
      timeMode: definition.timeMode,
      importance: definition.importance,
      hasPlannedStart: Boolean(definition.plannedStartAt),
    }, {
      ...(eventOffsetsMinutes ? { eventOffsetsMinutes } : {}),
      plannedTaskOffsetMinutes: settingsRow.plannedTaskReminderOffsetMinutes,
      criticalPostDueMinutes: settingsRow.criticalPostDueMinutes,
    });
    const ruleSpecs = withExplicitReminder(defaultRuleSpecs(definition, templates, settings), input.explicitReminder);
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
      id: randomUUID(), workspaceId: input.workspaceId, taskId, text: item.text.trim(), sortOrder: index, done: item.done,
    }));
    const recurrenceExclusionRows: Array<typeof taskRecurrenceExclusions.$inferInsert> =
      (definition.recurrenceExcludedLocalDates ?? []).map((localDate) => ({
        workspaceId: input.workspaceId,
        taskId,
        localDate,
      }));

    const ruleRows: Array<typeof reminderRules.$inferInsert> = ruleSpecs.map((rule, index) => ({
      id: ruleIds[index],
      workspaceId: input.workspaceId,
      taskId,
      triggerKind: rule.triggerKind,
      ...(rule.exactAt ? { exactAt: rule.exactAt } : {}),
      ...(rule.anchor ? { anchor: rule.anchor } : {}),
      ...(rule.offsetSeconds !== undefined ? { offsetSeconds: rule.offsetSeconds } : {}),
      ...(rule.daysOffset !== undefined ? { daysOffset: rule.daysOffset } : {}),
      ...(rule.localTime ? { localTime: rule.localTime } : {}),
      purpose: rule.purpose,
      quietPolicy: rule.quietPolicy,
      origin: rule.origin ?? "default",
      active: true,
    }));

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
        reminderSchedules: deliveryRows.filter((delivery) => delivery.status === "pending").map((delivery) => ({
          scheduledFor: delivery.scheduledFor,
          purpose: ruleSpecs.find((rule, index) => ruleIds[index] === delivery.reminderRuleId)?.purpose ?? "user_reminder",
        })),
        ...(occurrenceRows[0] ? { occurrenceSchedule: {
          timezone: occurrenceRows[0].timezone,
          plannedStartAt: occurrenceRows[0].plannedStartAt ?? null,
          plannedEndAt: occurrenceRows[0].plannedEndAt ?? null,
          plannedLocalDate: occurrenceRows[0].plannedLocalDate ?? null,
          dueAt: occurrenceRows[0].dueAt ?? null,
          dueLocalDate: occurrenceRows[0].dueLocalDate ?? null,
        } } : {}),
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
    const rows = [
      ...actionable,
      ...fuzzy.map((task) => ({ task, occurrence: null })),
    ].sort(compareTelegramTasks);
    const seenTaskIds = new Set<string>();
    return rows.filter((row) => {
      if (seenTaskIds.has(row.task.id)) return false;
      seenTaskIds.add(row.task.id);
      return true;
    }).slice(0, limit);
  }

  async listTodayForTelegram(workspaceId: string, localDate: string, limit = 20) {
    // Filter by the requested day before applying the display limit. This keeps
    // every occurrence on that day discoverable even when other series have many
    // materialized future occurrences.
    const [actionable, fuzzy] = await Promise.all([
      this.repository.listActionableForTelegram(workspaceId),
      this.repository.listFuzzyReviewsForLocalDate(workspaceId, localDate, limit),
    ]);
    const rows = actionable.filter(({ task, occurrence }) => {
      if (occurrence.overdue) return true;
      if (occurrence.plannedLocalDate === localDate || occurrence.dueLocalDate === localDate) return true;
      if (occurrence.plannedStartAt && localDateAt(occurrence.plannedStartAt, occurrence.timezone) === localDate) return true;
      if (occurrence.dueAt && localDateAt(occurrence.dueAt, occurrence.timezone) === localDate) return true;
      if (task.timeMode === "window" && occurrence.plannedEndAt && localDateAt(occurrence.plannedEndAt, occurrence.timezone) === localDate) return true;
      return false;
    });
    const reviews = fuzzy.map((task) => ({ task, occurrence: null }));
    return [...rows, ...reviews].sort(compareTelegramTasks).slice(0, limit);
  }

  async listCompletedTodayForTelegram(workspaceId: string, localDate: string) {
    const rows = await this.repository.listRecentlyCompletedForTelegram(workspaceId);
    return rows.filter(({ occurrence }) => occurrence.completedAt && localDateAt(occurrence.completedAt, occurrence.timezone) === localDate);
  }

  async getAiContext(workspaceId: string, taskLimit = 12) {
    const taskRows = await this.repository.listActiveTasksForAi(workspaceId, taskLimit);
    const taskIds = taskRows.map((task) => task.id);
    const [occurrenceRows, checklistRows] = await Promise.all([
      this.repository.listActiveOccurrencesForTasks(workspaceId, taskIds),
      this.repository.listChecklistForTasks(workspaceId, taskIds),
    ]);
    const byTask = new Map<string, typeof occurrenceRows>();
    for (const occurrence of occurrenceRows) {
      const list = byTask.get(occurrence.taskId) ?? [];
      if (list.length < 2) list.push(occurrence);
      byTask.set(occurrence.taskId, list);
    }
    const checklistByTask = new Map<string, typeof checklistRows>();
    for (const item of checklistRows) {
      const list = checklistByTask.get(item.taskId) ?? [];
      list.push(item);
      checklistByTask.set(item.taskId, list);
    }
    return taskRows.map((task) => ({
      taskId: task.id,
      taskVersion: task.version,
      title: task.title,
      kind: task.kind,
      importance: task.importance,
      context: task.context,
      timeMode: task.timeMode,
      recurring: Boolean(task.recurrenceRule),
      checklist: (checklistByTask.get(task.id) ?? []).map((item) => ({ text: item.text, done: item.done })),
      occurrences: (byTask.get(task.id) ?? []).map((occurrence) => ({
        occurrenceId: occurrence.id,
        occurrenceVersion: occurrence.version,
        status: occurrence.status,
        timezone: occurrence.timezone,
        plannedStartAt: occurrence.plannedStartAt?.toISOString() ?? null,
        plannedEndAt: occurrence.plannedEndAt?.toISOString() ?? null,
        plannedLocalDate: occurrence.plannedLocalDate,
        dueAt: occurrence.dueAt?.toISOString() ?? null,
        dueLocalDate: occurrence.dueLocalDate,
      })),
    }));
  }

  async getTask(workspaceId: string, taskId: string) {
    return this.repository.findTask(workspaceId, taskId);
  }

  countActiveCritical(workspaceId: string): Promise<number> { return this.repository.countActiveCritical(workspaceId); }

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
    if (!context) throw new Error("occurrence not found");
    const previous = await this.repository.countReschedules(workspaceId, occurrenceId);
    return isRescheduleReasonRequired(context.task.importance, previous);
  }

  async getCreatedTasksForActionGroup(workspaceId: string, groupId: string) {
    return this.repository.findTasksBySourceActionGroup(workspaceId, groupId);
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
    if (!occurrence) throw new Error("occurrence not found");
    const task = await this.repository.findTask(input.workspaceId, occurrence.taskId);
    if (!task) throw new Error("task not found");

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
    if (!result.ok) throw new Error(result.reason);

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

  async recordInteraction(input: {
    workspaceId: string;
    occurrenceId: string;
    actorUserId: string;
    eventType: "occurrence:seen" | "occurrence:cant_start";
  }): Promise<void> {
    const occurrence = await this.repository.findOccurrence(input.workspaceId, input.occurrenceId);
    if (!occurrence) throw new Error("occurrence not found");
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
    if (!occurrence) throw new Error("occurrence not found");
    const details = input.details.trim();
    if (!details) throw new Error("blocker cannot be empty");
    await this.repository.recordEvent({
      workspaceId: input.workspaceId, taskId: occurrence.taskId, occurrenceId: occurrence.id, actorUserId: input.actorUserId,
      eventType: "occurrence:blocker", details,
    });
  }

  /** Detail fields for a Telegram task card that are not on the task row itself. */
  async getTaskCardExtras(workspaceId: string, taskId: string): Promise<{ checklist: Array<{ text: string; done: boolean }>; goalTitle: string | null }> {
    const [checklist, goalTitle] = await Promise.all([
      this.repository.listChecklistForTasks(workspaceId, [taskId]),
      this.repository.findGoalTitleForTask(workspaceId, taskId),
    ]);
    return { checklist: checklist.map((item) => ({ text: item.text, done: item.done })), goalTitle };
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
  const importance = (value: typeof tasks.$inferSelect["importance"]) => value === "critical" ? 0 : value === "required" ? 1 : 2;
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

export function withExplicitReminder(defaults: ReminderRuleSpec[], explicit?: ReminderRuleSpec): ReminderRuleSpec[] {
  if (!explicit) return defaults;
  return [...defaults.filter((rule) => rule.purpose !== "user_reminder"), explicit];
}
