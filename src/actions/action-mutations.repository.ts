import crypto from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { validateOccurrenceTransition } from "../core/occurrence.js";
import { rescheduledDefinition, rescheduledOccurrenceStatus, type RescheduleFields } from "../core/reschedule.js";
import { isRescheduleReasonRequired } from "../core/task-policy.js";
import { localDateAt } from "../core/timezone.js";
import type { OccurrenceScheduleView } from "../core/time-presentation.js";
import { taskFieldChanges, type AppliedReportItem, type TaskFieldChange } from "../core/applied-report.js";
import type { ReminderRuleSpec } from "../core/reminder-planning.js";
import type { TaskDefinition, TimeMode } from "../core/types.js";
import { isTerminalOccurrenceStatus } from "../core/types.js";
import { type DatabaseService } from "../database/database.service.js";
import {
  actionEvents,
  reminderDeliveries,
  reminderRules,
  taskChecklistItems,
  taskEvents,
  taskOccurrences,
  taskRecurrenceExclusions,
  tasks,
  userSettings,
} from "../database/schema.js";
import { taskDefinitionFromRow } from "../tasks/task-record-mappers.js";
import { defaultReminderRuleRows } from "../tasks/task-plan-rules.js";
import { seriesOperationState } from "../core/series-policy.js";
import { DomainRuleError } from "../core/errors.js";

export type DbTransaction = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];

/** A row version a step left behind, so a later step of the same group addresses the row as it is now. */
export interface TouchedVersion {
  entity: "task" | "occurrence" | "goal" | "memory" | "settings";
  id: string;
  version: number;
}

export type SettingsOperation = Extract<AppliedReportItem, { kind: "settings" }>["operation"];

export type UpdateTaskPatch = {
  title?: string;
  why?: string;
  nextAction?: string;
  context?: string;
  importance?: "normal" | "required" | "critical";
  checklist?: Array<{ text: string; done: boolean }>;
  habitMode?: boolean;
  minimumAction?: string | null;
  desiredAction?: string | null;
  habitTrigger?: string | null;
};

export type SettingsPatch = Partial<
  Pick<
    typeof userSettings.$inferInsert,
    | "timezone"
    | "digestTimezone"
    | "quietHoursTimezone"
    | "pinnedLanguage"
    | "quietHoursEnabled"
    | "weekdayQuietStart"
    | "weekdayQuietEnd"
    | "weekendQuietStart"
    | "weekendQuietEnd"
    | "notificationsSnoozedUntil"
    | "morningReferenceTime"
    | "eveningReferenceTime"
    | "morningDigestEnabled"
    | "eveningDigestEnabled"
    | "weeklyReviewEnabled"
    | "weeklyReviewWeekday"
    | "weeklyReviewTime"
    | "eventReminderOffsetsMinutes"
    | "plannedTaskReminderOffsetMinutes"
    | "criticalPostDueMinutes"
  >
>;

interface GroupScope {
  workspaceId: string;
  groupId: string;
  actorUserId: string;
}

export interface UpdateSettingsInput extends GroupScope {
  expectedVersion: number;
  patch: SettingsPatch;
  operation?: SettingsOperation;
  now: Date;
}
export interface UpdateOccurrenceInput extends GroupScope {
  occurrenceId: string;
  expectedVersion: number;
  operation: "start" | "skip" | "cancel";
  now: Date;
}
export interface UpdateTaskInput extends GroupScope {
  taskId: string;
  expectedVersion: number;
  patch: UpdateTaskPatch;
  now: Date;
}
export interface CompleteOccurrenceInput extends GroupScope {
  occurrenceId: string;
  expectedVersion: number;
  now: Date;
}
export interface CompleteTaskInput extends GroupScope {
  taskId: string;
  expectedVersion: number;
  now: Date;
}
export interface CancelTaskInput extends GroupScope {
  taskId: string;
  expectedVersion: number;
  now: Date;
}
export interface RescheduleOccurrenceInput extends GroupScope {
  occurrenceId: string;
  expectedVersion: number;
  scheduleTimezone: string;
  schedule: RescheduleFields;
  /** The mode the new schedule compiles to; a point can become a window and back. */
  timeMode?: TimeMode;
  reason?: string;
  now: Date;
}
export interface ConcretiseTaskInput extends GroupScope {
  taskId: string;
  expectedVersion: number;
  definition: TaskDefinition;
  occurrenceStatus: "scheduled" | "open";
  explicitReminder?: ReminderRuleSpec;
  reason?: string;
  now: Date;
}
export interface ChangeReminderInput extends GroupScope {
  occurrenceId: string;
  expectedVersion: number;
  mode: "add" | "replace" | "clear";
  rule?: ReminderRuleSpec;
  now: Date;
}
export interface ChangeSeriesInput extends GroupScope {
  taskId: string;
  expectedVersion: number;
  operation: "pause" | "resume" | "stop" | "cancel" | "edit";
  editDefinition?: TaskDefinition;
  now: Date;
}

export interface UpdateSettingsStepResult {
  kind: "update_settings";
  userId: string;
  operation: SettingsOperation | null;
}
export interface UpdateOccurrenceStepResult {
  kind: "update_occurrence";
  taskId: string;
  occurrenceId: string;
  title: string;
  operation: "start" | "skip" | "cancel";
}
export interface UpdateTaskStepResult {
  kind: "update_task";
  taskId: string;
  title: string;
  renamedFrom: string | null;
  changes: TaskFieldChange[];
}
export interface CompleteTaskStepResult {
  kind: "complete_task";
  taskId: string;
  occurrenceId: string | null;
  title: string;
}
export interface CancelTaskStepResult {
  kind: "cancel_task";
  taskId: string;
  occurrenceId: string | null;
  title: string;
}
export interface RescheduleOccurrenceStepResult {
  kind: "reschedule_occurrence";
  taskId: string;
  occurrenceId: string;
  title: string;
  previousSchedule: OccurrenceScheduleView;
  occurrenceSchedule: OccurrenceScheduleView;
  becameFuzzy: boolean;
  reason: string | null;
}
export interface ConcretiseTaskStepResult {
  kind: "concretise_task";
  taskId: string;
  occurrenceId: string;
  title: string;
  previousFuzzyHorizonText: string | null;
  previousReviewAt: Date | null;
  occurrenceSchedule: OccurrenceScheduleView;
  reason: string | null;
}
export interface ChangeReminderStepResult {
  kind: "change_reminder";
  taskId: string;
  occurrenceId: string;
  title: string;
  mode: "add" | "replace" | "clear";
  occurrenceSchedule: OccurrenceScheduleView;
}
export interface ChangeSeriesStepResult {
  kind: "change_series";
  taskId: string;
  title: string;
  operation: "pause" | "resume" | "stop" | "cancel" | "edit";
  reconcile: boolean;
}

export type InTx<T> = T & { touched: TouchedVersion[] };

/** Result shape of the single-action wrappers, kept for the Telegram button flows. */
export interface MutationAppliedResult {
  groupId: string;
  undoable?: boolean;
  count: 1;
  titles: string[];
  reminderRebuildOccurrenceId?: string;
  reminderRebuildTaskId?: string;
  recurrenceReconcileTaskId?: string;
  occurrenceSchedule?: OccurrenceScheduleView;
  /** Previous title when an update_task changed it, so the reply can show old → new. */
  renamedFrom?: string;
  /** Field-level diff of an update_task, rendered verbatim in the applied report. */
  changes?: TaskFieldChange[];
  /** Schedule before a reschedule, so the report can show old → new. */
  previousSchedule?: OccurrenceScheduleView;
  scheduledReminderAt?: Date;
}

export async function updateSettingsInTx(tx: DbTransaction, input: UpdateSettingsInput): Promise<InTx<UpdateSettingsStepResult>> {
  const [before] = await tx
    .select()
    .from(userSettings)
    .where(and(eq(userSettings.userId, input.actorUserId), eq(userSettings.version, input.expectedVersion)))
    .limit(1);
  if (!before) throw new DomainRuleError("settings are stale or missing");
  const [after] = await tx
    .update(userSettings)
    .set({
      ...input.patch,
      version: sql`${userSettings.version} + 1`,
      updatedAt: input.now,
    })
    .where(and(eq(userSettings.userId, input.actorUserId), eq(userSettings.version, input.expectedVersion)))
    .returning();
  if (!after) throw new DomainRuleError("settings are stale or missing");
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "update_settings",
    entityType: "settings",
    entityId: input.actorUserId,
    postVersion: after.version,
    beforeState: settingsMutableState(before),
    afterState: settingsMutableState(after),
  });
  return {
    kind: "update_settings",
    userId: input.actorUserId,
    operation: input.operation ?? null,
    touched: [{ entity: "settings", id: input.actorUserId, version: after.version }],
  };
}

export async function updateOccurrenceInTx(tx: DbTransaction, input: UpdateOccurrenceInput): Promise<InTx<UpdateOccurrenceStepResult>> {
  const row = await loadOccurrence(tx, input.workspaceId, input.occurrenceId, input.expectedVersion);
  const touched: TouchedVersion[] = [];
  const nextStatus = input.operation === "start" ? "in_progress" : input.operation === "skip" ? "skipped" : "cancelled";
  const transition = validateOccurrenceTransition(row.occurrence.status, nextStatus, {
    kind: row.task.kind,
    recurring: Boolean(row.task.recurrenceRule),
    now: input.now,
    ...(row.occurrence.plannedStartAt ? { plannedStartAt: row.occurrence.plannedStartAt } : {}),
    ...(row.occurrence.plannedEndAt ? { plannedEndAt: row.occurrence.plannedEndAt } : {}),
    eventElapseGraceMinutes: 15,
    explicitUserAction: true,
    systemExpire: false,
  });
  if (!transition.ok) throw new DomainRuleError(transition.reason);
  const [afterOccurrence] = await tx
    .update(taskOccurrences)
    .set({
      status: nextStatus,
      version: sql`${taskOccurrences.version} + 1`,
      updatedAt: input.now,
    })
    .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, input.occurrenceId), eq(taskOccurrences.version, input.expectedVersion)))
    .returning();
  if (!afterOccurrence) throw new DomainRuleError("occurrence is stale or missing");
  touched.push({ entity: "occurrence", id: input.occurrenceId, version: afterOccurrence.version });
  const activeSystemFollowUps =
    input.operation === "start"
      ? await tx
          .select({ id: reminderRules.id })
          .from(reminderRules)
          .where(
            and(
              eq(reminderRules.workspaceId, input.workspaceId),
              eq(reminderRules.occurrenceId, input.occurrenceId),
              eq(reminderRules.purpose, "follow_up"),
              eq(reminderRules.origin, "system"),
              eq(reminderRules.active, true),
            ),
          )
      : [];
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "update_occurrence",
    entityType: "occurrence",
    entityId: input.occurrenceId,
    postVersion: afterOccurrence.version,
    beforeState: { ...occurrenceMutableState(row.occurrence), systemFollowUpRuleIds: activeSystemFollowUps.map((item) => item.id) },
    afterState: occurrenceMutableState(afterOccurrence),
  });
  if (input.operation === "cancel" && !row.task.recurrenceRule) {
    const [afterTask] = await tx
      .update(tasks)
      .set({ status: "cancelled", version: sql`${tasks.version} + 1`, updatedAt: input.now })
      .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, row.task.id), eq(tasks.version, row.task.version)))
      .returning();
    if (!afterTask) throw new DomainRuleError("task changed while cancelling occurrence");
    touched.push({ entity: "task", id: row.task.id, version: afterTask.version });
    await tx.insert(actionEvents).values({
      workspaceId: input.workspaceId,
      groupId: input.groupId,
      actionType: "update_occurrence",
      entityType: "task",
      entityId: row.task.id,
      postVersion: afterTask.version,
      beforeState: taskMutableState(row.task),
      afterState: taskMutableState(afterTask),
    });
  }
  if (input.operation === "start") {
    const ids = activeSystemFollowUps.map((item) => item.id);
    if (ids.length) {
      await tx
        .update(reminderDeliveries)
        .set({ status: "cancelled", suppressedReason: "superseded" })
        .where(
          and(
            eq(reminderDeliveries.workspaceId, input.workspaceId),
            eq(reminderDeliveries.occurrenceId, input.occurrenceId),
            inArray(reminderDeliveries.reminderRuleId, ids),
            inArray(reminderDeliveries.status, ["pending", "processing"]),
          ),
        );
      await tx
        .update(reminderRules)
        .set({ active: false })
        .where(and(eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, ids)));
    }
  } else {
    await suppressOccurrenceDeliveries(tx, input.workspaceId, input.occurrenceId);
  }
  await tx.insert(taskEvents).values({
    workspaceId: input.workspaceId,
    taskId: row.task.id,
    occurrenceId: input.occurrenceId,
    actorUserId: input.actorUserId,
    eventType: `occurrence:${nextStatus}`,
  });
  return { kind: "update_occurrence", taskId: row.task.id, occurrenceId: input.occurrenceId, title: row.task.title, operation: input.operation, touched };
}

export async function updateTaskInTx(tx: DbTransaction, input: UpdateTaskInput): Promise<InTx<UpdateTaskStepResult>> {
  const [before] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, input.taskId), eq(tasks.version, input.expectedVersion)))
    .limit(1);
  if (!before) throw new DomainRuleError("task is stale or missing");

  const beforeChecklist = await tx
    .select({ text: taskChecklistItems.text, done: taskChecklistItems.done })
    .from(taskChecklistItems)
    .where(and(eq(taskChecklistItems.workspaceId, input.workspaceId), eq(taskChecklistItems.taskId, input.taskId)))
    .orderBy(taskChecklistItems.sortOrder);
  const { checklist, ...taskPatch } = input.patch;
  if (taskPatch.habitMode === false) {
    taskPatch.minimumAction = null;
    taskPatch.desiredAction = null;
    taskPatch.habitTrigger = null;
  }
  const [after] = await tx
    .update(tasks)
    .set({
      ...taskPatch,
      version: sql`${tasks.version} + 1`,
      updatedAt: input.now,
    })
    .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, input.taskId), eq(tasks.version, input.expectedVersion)))
    .returning();
  if (!after) throw new DomainRuleError("task is stale or missing");

  let afterChecklist = beforeChecklist;
  if (checklist !== undefined) {
    await replaceChecklist(tx, input.workspaceId, input.taskId, checklist);
    afterChecklist = checklist;
  }

  await tx.insert(taskEvents).values({ workspaceId: input.workspaceId, taskId: input.taskId, actorUserId: input.actorUserId, eventType: "task:updated" });
  const beforeState = { ...taskMutableState(before), checklist: beforeChecklist };
  const afterState = { ...taskMutableState(after), checklist: afterChecklist };
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "update_task",
    entityType: "task",
    entityId: input.taskId,
    postVersion: after.version,
    beforeState,
    afterState,
  });
  return {
    kind: "update_task",
    taskId: input.taskId,
    title: after.title,
    renamedFrom: before.title !== after.title ? before.title : null,
    changes: taskFieldChanges(beforeState, afterState),
    touched: [{ entity: "task", id: input.taskId, version: after.version }],
  };
}

export async function completeOccurrenceInTx(tx: DbTransaction, input: CompleteOccurrenceInput): Promise<InTx<CompleteTaskStepResult>> {
  const row = await loadOccurrence(tx, input.workspaceId, input.occurrenceId, input.expectedVersion);
  return completeLoadedOccurrence(tx, input, row);
}

/** Closes through the live occurrence when there is one; an undated task closes directly. */
export async function completeTaskInTx(tx: DbTransaction, input: CompleteTaskInput): Promise<InTx<CompleteTaskStepResult>> {
  const task = await loadTask(tx, input.workspaceId, input.taskId, input.expectedVersion);
  if (task.status !== "active") throw new DomainRuleError("only an active task can be completed");

  const occurrence = await liveOccurrence(tx, input.workspaceId, task.id, ["scheduled", "open", "in_progress", "elapsed"]);
  if (occurrence) {
    return completeLoadedOccurrence(tx, { ...input, occurrenceId: occurrence.id, expectedVersion: occurrence.version }, { task, occurrence });
  }

  const [updatedTask] = await tx
    .update(tasks)
    .set({ status: "closed", version: sql`${tasks.version} + 1`, updatedAt: input.now })
    .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, task.id), eq(tasks.version, task.version)))
    .returning();
  if (!updatedTask) throw new DomainRuleError("task changed while completing it");
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "complete_task",
    entityType: "task",
    entityId: task.id,
    postVersion: updatedTask.version,
    beforeState: taskMutableState(task),
    afterState: taskMutableState(updatedTask),
  });
  await tx.insert(taskEvents).values({ workspaceId: input.workspaceId, taskId: task.id, actorUserId: input.actorUserId, eventType: "task:closed" });
  return { kind: "complete_task", taskId: task.id, occurrenceId: null, title: task.title, touched: [{ entity: "task", id: task.id, version: updatedTask.version }] };
}

/**
 * Cancellation addressed by task. A live occurrence is cancelled through the occurrence path;
 * an undated task has none and is cancelled directly, which also retires its planning review.
 */
export async function cancelTaskInTx(tx: DbTransaction, input: CancelTaskInput): Promise<InTx<CancelTaskStepResult>> {
  const task = await loadTask(tx, input.workspaceId, input.taskId, input.expectedVersion);
  if (task.status !== "active") throw new DomainRuleError("only an active task can be cancelled");

  // Cancelling the task means the task, not just the date in front of it. Closing only the
  // occurrence left the row active, so the task kept showing up in the list and in the model's
  // context — which is how a merge left the absorbed task alive.
  const occurrence = await liveOccurrence(tx, input.workspaceId, task.id, ["scheduled", "open", "in_progress"]);
  const occurrenceResult = occurrence ? await updateOccurrenceInTx(tx, { ...input, occurrenceId: occurrence.id, expectedVersion: occurrence.version, operation: "cancel" }) : null;

  const planningReviewRuleIds = await retirePlanningReview(tx, input.workspaceId, task.id);
  // Cancelling the occurrence bumps the task's version, so the row is re-read before the task
  // itself is closed; the optimistic check still holds, just against the version this step made.
  const current = occurrenceResult ? await loadTaskById(tx, input.workspaceId, task.id) : task;
  const [updatedTask] = await tx
    .update(tasks)
    .set({ status: "cancelled", version: sql`${tasks.version} + 1`, updatedAt: input.now })
    .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, task.id), eq(tasks.version, current.version)))
    .returning();
  if (!updatedTask) throw new DomainRuleError("task changed while cancelling it");
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "cancel_task",
    entityType: "task",
    entityId: task.id,
    postVersion: updatedTask.version,
    beforeState: { ...taskMutableState(task), planningReviewRuleIds },
    afterState: taskMutableState(updatedTask),
  });
  await tx.insert(taskEvents).values({ workspaceId: input.workspaceId, taskId: task.id, actorUserId: input.actorUserId, eventType: "task:cancelled" });
  return {
    kind: "cancel_task",
    taskId: task.id,
    occurrenceId: occurrence?.id ?? null,
    title: task.title,
    touched: [...(occurrenceResult?.touched ?? []), { entity: "task", id: task.id, version: updatedTask.version }],
  };
}

export async function rescheduleOccurrenceInTx(tx: DbTransaction, input: RescheduleOccurrenceInput): Promise<InTx<RescheduleOccurrenceStepResult>> {
  const row = await loadOccurrence(tx, input.workspaceId, input.occurrenceId, input.expectedVersion);
  if (isTerminalOccurrenceStatus(row.occurrence.status)) throw new DomainRuleError("terminal occurrence cannot be rescheduled");
  if (input.scheduleTimezone !== row.occurrence.timezone) throw new DomainRuleError("reschedule timezone must match the occurrence timezone");

  const previousReschedules = await tx
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(and(eq(taskEvents.workspaceId, input.workspaceId), eq(taskEvents.occurrenceId, input.occurrenceId), eq(taskEvents.eventType, "occurrence:rescheduled")));
  if (isRescheduleReasonRequired(row.task.importance, previousReschedules.length) && !input.reason?.trim()) {
    throw new DomainRuleError("reschedule reason is required");
  }

  const nextDefinition = rescheduledDefinition(taskDefinitionFromRow(row.task), input.schedule, input.timeMode);
  const becomesFuzzy = nextDefinition.timeMode === "fuzzy";
  if (becomesFuzzy && row.task.recurrenceRule) throw new DomainRuleError("recurring occurrence cannot become fuzzy");
  const nextStatus = becomesFuzzy ? "cancelled" : rescheduledOccurrenceStatus(nextDefinition, input.now);
  const touched: TouchedVersion[] = [];

  // A one-time task may return to planning without inventing a date. We keep the old
  // occurrence only as terminal history so sent reminders/audit remain referentially
  // intact; the fuzzy task has no active occurrence and its review reminder is task-level.
  const [updatedOccurrence] = await tx
    .update(taskOccurrences)
    .set({
      status: nextStatus,
      timezone: input.scheduleTimezone,
      ...(becomesFuzzy
        ? {}
        : {
            plannedStartAt: input.schedule.plannedStartAt ?? null,
            plannedEndAt: input.schedule.plannedEndAt ?? null,
            plannedLocalDate: input.schedule.plannedLocalDate ?? null,
            dueAt: input.schedule.dueAt ?? null,
            dueLocalDate: input.schedule.dueLocalDate ?? null,
          }),
      overdue: false,
      elapsedAt: null,
      completedAt: null,
      completedLate: false,
      ...(becomesFuzzy ? { skipReason: "rescheduled_to_fuzzy", needsReminderRebuild: false } : { skipReason: null, needsReminderRebuild: true }),
      version: sql`${taskOccurrences.version} + 1`,
      updatedAt: input.now,
    })
    .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, input.occurrenceId), eq(taskOccurrences.version, input.expectedVersion)))
    .returning();
  if (!updatedOccurrence) throw new DomainRuleError("occurrence is stale or missing");
  touched.push({ entity: "occurrence", id: input.occurrenceId, version: updatedOccurrence.version });

  await cancelOccurrenceDeliveries(tx, input.workspaceId, input.occurrenceId);
  const followUps = await tx
    .select({ id: reminderRules.id })
    .from(reminderRules)
    .where(
      and(
        eq(reminderRules.workspaceId, input.workspaceId),
        eq(reminderRules.occurrenceId, input.occurrenceId),
        eq(reminderRules.purpose, "follow_up"),
        eq(reminderRules.active, true),
      ),
    );
  if (followUps.length)
    await tx
      .update(reminderRules)
      .set({ active: false })
      .where(
        and(
          eq(reminderRules.workspaceId, input.workspaceId),
          inArray(
            reminderRules.id,
            followUps.map((item) => item.id),
          ),
        ),
      );

  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "reschedule_occurrence",
    entityType: "occurrence",
    entityId: input.occurrenceId,
    postVersion: updatedOccurrence.version,
    beforeState: occurrenceMutableState(row.occurrence),
    afterState: occurrenceMutableState(updatedOccurrence),
  });

  if (!row.task.recurrenceRule) {
    const [updatedTask] = await tx
      .update(tasks)
      .set({
        timeMode: nextDefinition.timeMode,
        timezone: nextDefinition.timezone,
        plannedStartAt: nextDefinition.plannedStartAt ?? null,
        plannedEndAt: nextDefinition.plannedEndAt ?? null,
        plannedLocalDate: nextDefinition.plannedLocalDate ?? null,
        dueAt: nextDefinition.dueAt ?? null,
        dueLocalDate: nextDefinition.dueLocalDate ?? null,
        fuzzyHorizonText: nextDefinition.fuzzyHorizonText ?? null,
        reviewAt: nextDefinition.reviewAt ?? null,
        version: sql`${tasks.version} + 1`,
        updatedAt: input.now,
      })
      .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, row.task.id), eq(tasks.version, row.task.version)))
      .returning();
    if (!updatedTask) throw new DomainRuleError("task changed while rescheduling occurrence");
    touched.push({ entity: "task", id: row.task.id, version: updatedTask.version });
    await tx.insert(actionEvents).values({
      workspaceId: input.workspaceId,
      groupId: input.groupId,
      actionType: "reschedule_occurrence",
      entityType: "task",
      entityId: row.task.id,
      postVersion: updatedTask.version,
      beforeState: taskMutableState(row.task),
      afterState: taskMutableState(updatedTask),
    });
  }

  await tx.insert(taskEvents).values({
    workspaceId: input.workspaceId,
    taskId: row.task.id,
    occurrenceId: input.occurrenceId,
    actorUserId: input.actorUserId,
    eventType: "occurrence:rescheduled",
    ...(input.reason?.trim() ? { details: input.reason.trim() } : {}),
  });
  return {
    kind: "reschedule_occurrence",
    taskId: row.task.id,
    occurrenceId: input.occurrenceId,
    title: row.task.title,
    previousSchedule: scheduleView(row.occurrence),
    occurrenceSchedule: scheduleView(updatedOccurrence),
    becameFuzzy: becomesFuzzy,
    reason: input.reason?.trim() || null,
    touched,
  };
}

/**
 * A fuzzy task gets a concrete time: the task takes the new definition, its first occurrence
 * is created, the planning review retires and the default reminder rules of a freshly created
 * task are inserted. Deliveries are built by the occurrence reminder rebuild after commit.
 */
export async function concretiseTaskInTx(tx: DbTransaction, input: ConcretiseTaskInput): Promise<InTx<ConcretiseTaskStepResult>> {
  const task = await loadTask(tx, input.workspaceId, input.taskId, input.expectedVersion);
  if (task.status !== "active") throw new DomainRuleError("only an active task can be scheduled");
  if (task.timeMode !== "fuzzy" || task.recurrenceRule) throw new DomainRuleError("only a fuzzy one-time task can be concretised");
  if (input.definition.timeMode === "fuzzy") throw new DomainRuleError("concretised definition must carry a concrete time");
  const [settingsRow] = await tx.select().from(userSettings).where(eq(userSettings.userId, input.actorUserId)).limit(1);
  if (!settingsRow) throw new DomainRuleError("actor settings are missing");

  const planningReviewRuleIds = await retirePlanningReview(tx, input.workspaceId, task.id);
  const definition = input.definition;
  const [updatedTask] = await tx
    .update(tasks)
    .set({
      timeMode: definition.timeMode,
      timezone: definition.timezone,
      plannedStartAt: definition.plannedStartAt ?? null,
      plannedEndAt: definition.plannedEndAt ?? null,
      plannedLocalDate: definition.plannedLocalDate ?? null,
      dueAt: definition.dueAt ?? null,
      dueLocalDate: definition.dueLocalDate ?? null,
      fuzzyHorizonText: null,
      reviewAt: null,
      version: sql`${tasks.version} + 1`,
      updatedAt: input.now,
    })
    .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, task.id), eq(tasks.version, task.version)))
    .returning();
  if (!updatedTask) throw new DomainRuleError("task changed while scheduling it");

  const occurrenceId = crypto.randomUUID();
  const [occurrence] = await tx
    .insert(taskOccurrences)
    .values({
      id: occurrenceId,
      workspaceId: input.workspaceId,
      taskId: task.id,
      seriesRevision: 1,
      status: input.occurrenceStatus,
      timezone: definition.timezone,
      ...(definition.plannedStartAt ? { plannedStartAt: definition.plannedStartAt } : {}),
      ...(definition.plannedEndAt ? { plannedEndAt: definition.plannedEndAt } : {}),
      ...(definition.plannedLocalDate ? { plannedLocalDate: definition.plannedLocalDate } : {}),
      ...(definition.dueAt ? { dueAt: definition.dueAt } : {}),
      ...(definition.dueLocalDate ? { dueLocalDate: definition.dueLocalDate } : {}),
      needsReminderRebuild: true,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!occurrence) throw new Error("failed to create the occurrence");

  const ruleRows = defaultReminderRuleRows({
    workspaceId: input.workspaceId,
    taskId: task.id,
    definition,
    settingsRow,
    ...(input.explicitReminder ? { explicitReminder: input.explicitReminder } : {}),
  });
  if (ruleRows.length) await tx.insert(reminderRules).values(ruleRows);
  const insertedRuleIds = ruleRows.map((rule) => rule.id).filter((id): id is string => typeof id === "string");

  await tx.insert(actionEvents).values([
    {
      workspaceId: input.workspaceId,
      groupId: input.groupId,
      actionType: "concretise_task",
      entityType: "task",
      entityId: task.id,
      postVersion: updatedTask.version,
      beforeState: { ...taskMutableState(task), planningReviewRuleIds },
      afterState: { ...taskMutableState(updatedTask), insertedRuleIds },
    },
    {
      workspaceId: input.workspaceId,
      groupId: input.groupId,
      actionType: "occurrence_created",
      entityType: "occurrence",
      entityId: occurrenceId,
      postVersion: occurrence.version,
      beforeState: null,
      afterState: occurrenceMutableState(occurrence),
    },
  ]);
  await tx.insert(taskEvents).values({
    workspaceId: input.workspaceId,
    taskId: task.id,
    actorUserId: input.actorUserId,
    eventType: "task:scheduled",
    ...(input.reason?.trim() ? { details: input.reason.trim() } : {}),
  });
  return {
    kind: "concretise_task",
    taskId: task.id,
    occurrenceId,
    title: task.title,
    previousFuzzyHorizonText: task.fuzzyHorizonText,
    previousReviewAt: task.reviewAt,
    occurrenceSchedule: scheduleView(occurrence),
    reason: input.reason?.trim() || null,
    touched: [
      { entity: "task", id: task.id, version: updatedTask.version },
      { entity: "occurrence", id: occurrenceId, version: occurrence.version },
    ],
  };
}

export async function changeReminderInTx(tx: DbTransaction, input: ChangeReminderInput): Promise<InTx<ChangeReminderStepResult>> {
  const row = await loadOccurrence(tx, input.workspaceId, input.occurrenceId, input.expectedVersion);
  if (isTerminalOccurrenceStatus(row.occurrence.status)) throw new DomainRuleError("terminal occurrence cannot change reminders");

  const explicit = await tx
    .select({ id: reminderRules.id })
    .from(reminderRules)
    .where(
      and(
        eq(reminderRules.workspaceId, input.workspaceId),
        eq(reminderRules.occurrenceId, input.occurrenceId),
        eq(reminderRules.origin, "explicit"),
        eq(reminderRules.active, true),
      ),
    );
  const beforeRuleIds = explicit.map((item) => item.id);
  if (input.mode !== "add" && beforeRuleIds.length) {
    await tx
      .update(reminderRules)
      .set({ active: false })
      .where(and(eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, beforeRuleIds)));
    await tx
      .update(reminderDeliveries)
      .set({ status: "cancelled", suppressedReason: "superseded" })
      .where(
        and(
          eq(reminderDeliveries.workspaceId, input.workspaceId),
          eq(reminderDeliveries.occurrenceId, input.occurrenceId),
          inArray(reminderDeliveries.status, ["pending", "processing"]),
          inArray(reminderDeliveries.reminderRuleId, beforeRuleIds),
        ),
      );
  }

  let insertedRuleId: string | null = null;
  if (input.mode !== "clear") {
    if (!input.rule) throw new DomainRuleError("reminder rule is required");
    insertedRuleId = crypto.randomUUID();
    await tx.insert(reminderRules).values({
      id: insertedRuleId,
      workspaceId: input.workspaceId,
      taskId: row.task.id,
      occurrenceId: input.occurrenceId,
      triggerKind: input.rule.triggerKind,
      ...(input.rule.exactAt ? { exactAt: input.rule.exactAt } : {}),
      ...(input.rule.anchor ? { anchor: input.rule.anchor } : {}),
      ...(input.rule.offsetSeconds !== undefined ? { offsetSeconds: input.rule.offsetSeconds } : {}),
      ...(input.rule.daysOffset !== undefined ? { daysOffset: input.rule.daysOffset } : {}),
      ...(input.rule.localTime ? { localTime: input.rule.localTime } : {}),
      purpose: input.rule.purpose,
      quietPolicy: input.rule.quietPolicy,
      origin: "explicit",
    });
  }
  const afterRuleIds = input.mode === "add" ? [...beforeRuleIds, ...(insertedRuleId ? [insertedRuleId] : [])] : insertedRuleId ? [insertedRuleId] : [];

  await cancelOccurrenceDeliveries(tx, input.workspaceId, input.occurrenceId);
  const [after] = await tx
    .update(taskOccurrences)
    .set({
      needsReminderRebuild: true,
      defaultRemindersSuppressed: input.mode === "add" ? row.occurrence.defaultRemindersSuppressed : true,
      version: sql`${taskOccurrences.version} + 1`,
      updatedAt: input.now,
    })
    .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, input.occurrenceId), eq(taskOccurrences.version, input.expectedVersion)))
    .returning();
  if (!after) throw new DomainRuleError("occurrence changed while updating reminder");

  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "change_reminder",
    entityType: "occurrence",
    entityId: input.occurrenceId,
    postVersion: after.version,
    beforeState: { ...occurrenceMutableState(row.occurrence), explicitReminderRuleIds: beforeRuleIds },
    afterState: { ...occurrenceMutableState(after), explicitReminderRuleIds: afterRuleIds },
  });
  await tx
    .insert(taskEvents)
    .values({ workspaceId: input.workspaceId, taskId: row.task.id, occurrenceId: input.occurrenceId, actorUserId: input.actorUserId, eventType: "reminder:changed" });
  return {
    kind: "change_reminder",
    taskId: row.task.id,
    occurrenceId: input.occurrenceId,
    title: row.task.title,
    mode: input.mode,
    occurrenceSchedule: scheduleView(after),
    touched: [{ entity: "occurrence", id: input.occurrenceId, version: after.version }],
  };
}

export async function changeSeriesInTx(tx: DbTransaction, input: ChangeSeriesInput): Promise<InTx<ChangeSeriesStepResult>> {
  const task = await loadTask(tx, input.workspaceId, input.taskId, input.expectedVersion, "series task is stale or missing");
  if (!task.recurrenceRule && input.operation !== "resume") throw new DomainRuleError("task is not a recurring series");
  if (input.operation === "resume" && (task.status !== "paused" || !task.recurrenceRule)) throw new DomainRuleError("only a paused recurring series can resume");
  if (input.operation === "edit" && !input.editDefinition) throw new DomainRuleError("series edit definition is required");
  const touched: TouchedVersion[] = [];

  const beforeExclusions = await tx
    .select({ localDate: taskRecurrenceExclusions.localDate })
    .from(taskRecurrenceExclusions)
    .where(and(eq(taskRecurrenceExclusions.workspaceId, input.workspaceId), eq(taskRecurrenceExclusions.taskId, input.taskId)));
  const occurrences = await tx
    .select()
    .from(taskOccurrences)
    .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.taskId, input.taskId)));
  const hasCurrent = occurrences.some((row) => ["open", "in_progress"].includes(row.status) && (row.status === "in_progress" || !occurrenceStillFuture(row, input.now)));
  const parentStatus = input.operation === "edit" ? task.status : seriesOperationState(input.operation, hasCurrent).parentStatus;

  const taskPatch: Partial<typeof tasks.$inferInsert> = { status: parentStatus, updatedAt: input.now };
  if (input.operation === "stop") {
    taskPatch.recurrenceRule = null;
    taskPatch.recurrenceTimezone = null;
    taskPatch.recurrenceEndLocalDate = null;
    taskPatch.missPolicy = null;
  }
  if (input.operation === "edit") {
    const definition = input.editDefinition!;
    taskPatch.timezone = definition.timezone;
    taskPatch.plannedStartAt = definition.plannedStartAt ?? null;
    taskPatch.plannedEndAt = definition.plannedEndAt ?? null;
    taskPatch.plannedLocalDate = definition.plannedLocalDate ?? null;
    taskPatch.dueAt = definition.dueAt ?? null;
    taskPatch.dueLocalDate = definition.dueLocalDate ?? null;
    taskPatch.recurrenceRule = definition.recurrenceRule!;
    taskPatch.recurrenceTimezone = definition.recurrenceTimezone!;
    taskPatch.recurrenceEndLocalDate = definition.recurrenceEndLocalDate ?? null;
    taskPatch.missPolicy = definition.missPolicy ?? null;
    taskPatch.seriesRevision = task.seriesRevision + 1;
  }

  const [afterTask] = await tx
    .update(tasks)
    .set({ ...taskPatch, version: sql`${tasks.version} + 1` })
    .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, input.taskId), eq(tasks.version, input.expectedVersion)))
    .returning();
  if (!afterTask) throw new DomainRuleError("series task changed");
  touched.push({ entity: "task", id: input.taskId, version: afterTask.version });
  if (input.operation === "stop" || input.operation === "edit") {
    await tx.delete(taskRecurrenceExclusions).where(and(eq(taskRecurrenceExclusions.workspaceId, input.workspaceId), eq(taskRecurrenceExclusions.taskId, input.taskId)));
    if (input.operation === "edit" && input.editDefinition?.recurrenceExcludedLocalDates?.length) {
      await tx.insert(taskRecurrenceExclusions).values(
        input.editDefinition.recurrenceExcludedLocalDates.map((localDate) => ({
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          localDate,
        })),
      );
    }
  }
  const afterExcludedDates =
    input.operation === "edit" ? [...(input.editDefinition?.recurrenceExcludedLocalDates ?? [])] : input.operation === "stop" ? [] : beforeExclusions.map((row) => row.localDate);
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "change_series",
    entityType: "task",
    entityId: task.id,
    postVersion: afterTask.version,
    beforeState: taskMutableState(
      task,
      beforeExclusions.map((row) => row.localDate),
    ),
    afterState: taskMutableState(afterTask, afterExcludedDates),
  });

  for (const occurrence of occurrences) {
    const future = occurrenceStillFuture(occurrence, input.now);
    const nonterminal = ["scheduled", "open", "in_progress"].includes(occurrence.status);
    let nextStatus: typeof occurrence.status | null = null;
    let skipReason: string | null = occurrence.skipReason;

    if (input.operation === "pause" && future && nonterminal && occurrence.status !== "in_progress") {
      nextStatus = "cancelled";
      skipReason = "series_paused_projection";
    }
    if (input.operation === "stop" && future && nonterminal && occurrence.status !== "in_progress") {
      nextStatus = "cancelled";
      skipReason = "series_stopped_projection";
    }
    if (input.operation === "edit" && future && nonterminal && occurrence.status !== "in_progress") {
      nextStatus = "cancelled";
      skipReason = "series_edited_projection";
    }
    if (input.operation === "cancel" && nonterminal) {
      nextStatus = "cancelled";
      skipReason = "series_cancelled";
    }
    if (input.operation === "resume" && occurrence.status === "cancelled" && occurrence.skipReason === "series_paused_projection" && future) {
      nextStatus = restoredFutureStatus(occurrence, task);
      skipReason = null;
    }
    if (!nextStatus || nextStatus === occurrence.status) continue;

    const [afterOccurrence] = await tx
      .update(taskOccurrences)
      .set({
        status: nextStatus,
        skipReason,
        version: sql`${taskOccurrences.version} + 1`,
        updatedAt: input.now,
      })
      .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, occurrence.id), eq(taskOccurrences.version, occurrence.version)))
      .returning();
    if (!afterOccurrence) throw new DomainRuleError("series occurrence changed");
    touched.push({ entity: "occurrence", id: occurrence.id, version: afterOccurrence.version });
    await tx.insert(actionEvents).values({
      workspaceId: input.workspaceId,
      groupId: input.groupId,
      actionType: "change_series",
      entityType: "occurrence",
      entityId: occurrence.id,
      postVersion: afterOccurrence.version,
      beforeState: occurrenceMutableState(occurrence),
      afterState: occurrenceMutableState(afterOccurrence),
    });
    await cancelOccurrenceDeliveries(tx, input.workspaceId, occurrence.id);
  }

  await tx.insert(taskEvents).values({ workspaceId: input.workspaceId, taskId: task.id, actorUserId: input.actorUserId, eventType: `series:${input.operation}` });
  const reconcile = input.operation === "resume" || (input.operation === "edit" && afterTask.status === "active");
  return { kind: "change_series", taskId: task.id, title: task.title, operation: input.operation, reconcile, touched };
}

async function completeLoadedOccurrence(
  tx: DbTransaction,
  input: { workspaceId: string; groupId: string; actorUserId: string; occurrenceId: string; expectedVersion: number; now: Date },
  row: { task: typeof tasks.$inferSelect; occurrence: typeof taskOccurrences.$inferSelect },
): Promise<InTx<CompleteTaskStepResult>> {
  const transition = validateOccurrenceTransition(row.occurrence.status, "done", {
    kind: row.task.kind,
    recurring: Boolean(row.task.recurrenceRule),
    now: input.now,
    ...(row.occurrence.plannedStartAt ? { plannedStartAt: row.occurrence.plannedStartAt } : {}),
    ...(row.occurrence.plannedEndAt ? { plannedEndAt: row.occurrence.plannedEndAt } : {}),
    eventElapseGraceMinutes: 15,
    explicitUserAction: true,
    systemExpire: false,
  });
  if (!transition.ok) throw new DomainRuleError(transition.reason);
  const touched: TouchedVersion[] = [];

  const [updatedOccurrence] = await tx
    .update(taskOccurrences)
    .set({
      status: "done",
      completedAt: input.now,
      completedLate: row.occurrence.status === "elapsed",
      version: sql`${taskOccurrences.version} + 1`,
      updatedAt: input.now,
    })
    .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, input.occurrenceId), eq(taskOccurrences.version, input.expectedVersion)))
    .returning();
  if (!updatedOccurrence) throw new DomainRuleError("occurrence is stale or missing");
  touched.push({ entity: "occurrence", id: input.occurrenceId, version: updatedOccurrence.version });

  await suppressOccurrenceDeliveries(tx, input.workspaceId, input.occurrenceId);
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "complete_occurrence",
    entityType: "occurrence",
    entityId: input.occurrenceId,
    postVersion: updatedOccurrence.version,
    beforeState: occurrenceMutableState(row.occurrence),
    afterState: occurrenceMutableState(updatedOccurrence),
  });

  if (!row.task.recurrenceRule) {
    const [updatedTask] = await tx
      .update(tasks)
      .set({ status: "closed", version: sql`${tasks.version} + 1`, updatedAt: input.now })
      .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, row.task.id), eq(tasks.version, row.task.version)))
      .returning();
    if (!updatedTask) throw new DomainRuleError("task changed while completing occurrence");
    touched.push({ entity: "task", id: row.task.id, version: updatedTask.version });
    await tx.insert(actionEvents).values({
      workspaceId: input.workspaceId,
      groupId: input.groupId,
      actionType: "complete_occurrence",
      entityType: "task",
      entityId: row.task.id,
      postVersion: updatedTask.version,
      beforeState: taskMutableState(row.task),
      afterState: taskMutableState(updatedTask),
    });
  }

  await tx.insert(taskEvents).values({
    workspaceId: input.workspaceId,
    taskId: row.task.id,
    occurrenceId: input.occurrenceId,
    actorUserId: input.actorUserId,
    eventType: "occurrence:done",
  });
  return { kind: "complete_task", taskId: row.task.id, occurrenceId: input.occurrenceId, title: row.task.title, touched };
}

async function loadTaskById(tx: DbTransaction, workspaceId: string, taskId: string) {
  const [task] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)))
    .limit(1);
  if (!task) throw new DomainRuleError("task is stale or missing");
  return task;
}

async function loadTask(tx: DbTransaction, workspaceId: string, taskId: string, expectedVersion: number, message = "task is stale or missing") {
  const [task] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId), eq(tasks.version, expectedVersion)))
    .limit(1);
  if (!task) throw new DomainRuleError(message);
  return task;
}

async function loadOccurrence(tx: DbTransaction, workspaceId: string, occurrenceId: string, expectedVersion: number) {
  const [row] = await tx
    .select({ task: tasks, occurrence: taskOccurrences })
    .from(taskOccurrences)
    .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
    .where(and(eq(taskOccurrences.workspaceId, workspaceId), eq(taskOccurrences.id, occurrenceId), eq(taskOccurrences.version, expectedVersion)))
    .limit(1);
  if (!row) throw new DomainRuleError("occurrence is stale or missing");
  return row;
}

async function liveOccurrence(tx: DbTransaction, workspaceId: string, taskId: string, statuses: Array<(typeof taskOccurrences.$inferSelect)["status"]>) {
  const [occurrence] = await tx
    .select()
    .from(taskOccurrences)
    .where(and(eq(taskOccurrences.workspaceId, workspaceId), eq(taskOccurrences.taskId, taskId), inArray(taskOccurrences.status, statuses)))
    .orderBy(asc(taskOccurrences.plannedStartAt))
    .limit(1);
  return occurrence ?? null;
}

/** Deactivates the task-level planning review and suppresses what it still had queued; returns the retired rule ids. */
async function retirePlanningReview(tx: DbTransaction, workspaceId: string, taskId: string): Promise<string[]> {
  const rules = await tx
    .select({ id: reminderRules.id })
    .from(reminderRules)
    .where(
      and(
        eq(reminderRules.workspaceId, workspaceId),
        eq(reminderRules.taskId, taskId),
        isNull(reminderRules.occurrenceId),
        eq(reminderRules.purpose, "planning_review"),
        eq(reminderRules.active, true),
      ),
    );
  const ids = rules.map((rule) => rule.id);
  if (!ids.length) return ids;
  await tx
    .update(reminderDeliveries)
    .set({ status: "suppressed", suppressedReason: "no_longer_applicable" })
    .where(and(eq(reminderDeliveries.workspaceId, workspaceId), inArray(reminderDeliveries.reminderRuleId, ids), inArray(reminderDeliveries.status, ["pending", "processing"])));
  await tx
    .update(reminderRules)
    .set({ active: false })
    .where(and(eq(reminderRules.workspaceId, workspaceId), inArray(reminderRules.id, ids)));
  return ids;
}

async function suppressOccurrenceDeliveries(tx: DbTransaction, workspaceId: string, occurrenceId: string): Promise<void> {
  await tx
    .update(reminderDeliveries)
    .set({ status: "suppressed", suppressedReason: "no_longer_applicable" })
    .where(and(eq(reminderDeliveries.workspaceId, workspaceId), eq(reminderDeliveries.occurrenceId, occurrenceId), inArray(reminderDeliveries.status, ["pending", "processing"])));
}

export async function cancelOccurrenceDeliveries(tx: DbTransaction, workspaceId: string, occurrenceId: string): Promise<void> {
  await tx
    .update(reminderDeliveries)
    .set({ status: "cancelled", suppressedReason: "superseded" })
    .where(and(eq(reminderDeliveries.workspaceId, workspaceId), eq(reminderDeliveries.occurrenceId, occurrenceId), inArray(reminderDeliveries.status, ["pending", "processing"])));
}

export async function replaceChecklist(tx: DbTransaction, workspaceId: string, taskId: string, checklist: ReadonlyArray<{ text: string; done: boolean }>): Promise<void> {
  await tx.delete(taskChecklistItems).where(and(eq(taskChecklistItems.workspaceId, workspaceId), eq(taskChecklistItems.taskId, taskId)));
  if (checklist.length) {
    await tx.insert(taskChecklistItems).values(checklist.map((item, index) => ({ workspaceId, taskId, text: item.text, done: item.done, sortOrder: index })));
  }
}

export function scheduleView(row: typeof taskOccurrences.$inferSelect): OccurrenceScheduleView {
  return {
    timezone: row.timezone,
    plannedStartAt: row.plannedStartAt,
    plannedEndAt: row.plannedEndAt,
    plannedLocalDate: row.plannedLocalDate,
    dueAt: row.dueAt,
    dueLocalDate: row.dueLocalDate,
  };
}

export function taskMutableState(row: typeof tasks.$inferSelect, recurrenceExcludedLocalDates: readonly string[] = []) {
  return {
    title: row.title,
    why: row.why,
    nextAction: row.nextAction,
    context: row.context,
    importance: row.importance,
    status: row.status,
    timeMode: row.timeMode,
    timezone: row.timezone,
    plannedStartAt: row.plannedStartAt?.toISOString() ?? null,
    plannedEndAt: row.plannedEndAt?.toISOString() ?? null,
    plannedLocalDate: row.plannedLocalDate,
    dueAt: row.dueAt?.toISOString() ?? null,
    dueLocalDate: row.dueLocalDate,
    fuzzyHorizonText: row.fuzzyHorizonText,
    reviewAt: row.reviewAt?.toISOString() ?? null,
    pickedWeekStart: row.pickedWeekStart,
    recurrenceRule: row.recurrenceRule,
    recurrenceTimezone: row.recurrenceTimezone,
    recurrenceEndLocalDate: row.recurrenceEndLocalDate,
    recurrenceExcludedLocalDates: [...recurrenceExcludedLocalDates],
    missPolicy: row.missPolicy,
    habitMode: row.habitMode,
    minimumAction: row.minimumAction,
    desiredAction: row.desiredAction,
    habitTrigger: row.habitTrigger,
    habitOfferSentAt: row.habitOfferSentAt?.toISOString() ?? null,
    seriesRevision: row.seriesRevision,
  };
}

export type TaskMutableState = ReturnType<typeof taskMutableState>;

export function settingsMutableState(row: typeof userSettings.$inferSelect) {
  return {
    timezone: row.timezone,
    digestTimezone: row.digestTimezone,
    quietHoursTimezone: row.quietHoursTimezone,
    pinnedLanguage: row.pinnedLanguage,
    quietHoursEnabled: row.quietHoursEnabled,
    weekdayQuietStart: row.weekdayQuietStart,
    weekdayQuietEnd: row.weekdayQuietEnd,
    weekendQuietStart: row.weekendQuietStart,
    weekendQuietEnd: row.weekendQuietEnd,
    notificationsSnoozedUntil: row.notificationsSnoozedUntil?.toISOString() ?? null,
    morningReferenceTime: row.morningReferenceTime,
    eveningReferenceTime: row.eveningReferenceTime,
    morningDigestEnabled: row.morningDigestEnabled,
    eveningDigestEnabled: row.eveningDigestEnabled,
    weeklyReviewEnabled: row.weeklyReviewEnabled,
    weeklyReviewWeekday: row.weeklyReviewWeekday,
    weeklyReviewTime: row.weeklyReviewTime,
    eventReminderOffsetsMinutes: row.eventReminderOffsetsMinutes,
    plannedTaskReminderOffsetMinutes: row.plannedTaskReminderOffsetMinutes,
    criticalPostDueMinutes: row.criticalPostDueMinutes,
  };
}

export type SettingsMutableState = ReturnType<typeof settingsMutableState>;

export function occurrenceMutableState(row: typeof taskOccurrences.$inferSelect) {
  return {
    status: row.status,
    timezone: row.timezone,
    plannedStartAt: row.plannedStartAt?.toISOString() ?? null,
    plannedEndAt: row.plannedEndAt?.toISOString() ?? null,
    plannedLocalDate: row.plannedLocalDate,
    dueAt: row.dueAt?.toISOString() ?? null,
    dueLocalDate: row.dueLocalDate,
    overdue: row.overdue,
    elapsedAt: row.elapsedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    completedLate: row.completedLate,
    skipReason: row.skipReason,
    needsReminderRebuild: row.needsReminderRebuild,
    defaultRemindersSuppressed: row.defaultRemindersSuppressed,
    seriesRevision: row.seriesRevision,
  };
}

export type OccurrenceMutableState = ReturnType<typeof occurrenceMutableState>;

function occurrenceStillFuture(row: typeof taskOccurrences.$inferSelect, now: Date): boolean {
  const boundary = row.plannedStartAt ?? row.dueAt;
  if (boundary) return boundary > now;
  const localBoundary = row.plannedLocalDate ?? row.dueLocalDate;
  if (localBoundary) return localBoundary >= localDateAt(now, row.timezone);
  return false;
}

function restoredFutureStatus(occurrence: typeof taskOccurrences.$inferSelect, task: typeof tasks.$inferSelect): "scheduled" | "open" {
  if (task.timeMode === "deadline" && !occurrence.plannedStartAt && !occurrence.plannedLocalDate) return "open";
  return "scheduled";
}

export function parseJsonDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}
