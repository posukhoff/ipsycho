import { Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { TaskBatchStepDraft, TaskBatchTaskRef } from "../core/ai-actions.js";
import { isRescheduleReasonRequired } from "../core/task-policy.js";
import { rescheduledDefinition, rescheduledOccurrenceStatus, type RescheduleFields } from "../core/reschedule.js";
import { DatabaseService } from "../database/database.service.js";
import {
  actionEvents, actionGroups, goals, pendingActions, reminderDeliveries, reminderRules,
  taskChecklistItems, taskEvents, taskGoals, taskOccurrences, taskRecurrenceExclusions, tasks,
} from "../database/schema.js";
import type { BuiltTaskPlan } from "../tasks/tasks.service.js";
import { taskDefinitionFromRow } from "../tasks/task-record-mappers.js";

export interface PreparedTaskBatchCreate {
  kind: "create";
  stepId: string;
  built: BuiltTaskPlan;
  action: Extract<TaskBatchStepDraft, { operation: "create" }>;
}

export interface PreparedTaskBatchUpdate {
  kind: "update";
  stepId: string;
  target: TaskBatchTaskRef;
  patch: {
    title?: string; why?: string; nextAction?: string; context?: string; importance?: "normal" | "required" | "critical";
    checklist?: Array<{ text: string; done: boolean }>;
    habitMode?: boolean; minimumAction?: string | null; desiredAction?: string | null; habitTrigger?: string | null;
  };
}

export interface PreparedTaskBatchReschedule {
  kind: "reschedule";
  stepId: string;
  occurrenceId: string;
  expectedVersion: number;
  scheduleTimezone: string;
  schedule: RescheduleFields;
  reason?: string;
}

export interface PreparedTaskBatchLink {
  kind: "link";
  stepId: string;
  target: TaskBatchTaskRef;
  goalId: string;
  expectedGoalVersion: number;
  source: "user_explicit" | "ai_inferred";
  confidence: number;
}

export type PreparedTaskBatchStep = PreparedTaskBatchCreate | PreparedTaskBatchUpdate | PreparedTaskBatchReschedule | PreparedTaskBatchLink;

export interface TaskBatchApplyResult {
  groupId: string;
  count: number;
  titles: string[];
  reminderRebuildOccurrenceIds: string[];
}

@Injectable()
export class TaskBatchRepository {
  constructor(private readonly database: DatabaseService) {}

  async apply(input: {
    workspaceId: string; actorUserId: string; groupId: string; sourceMessageId?: string;
    groupExists: boolean; steps: readonly PreparedTaskBatchStep[]; undoExpiresAt: Date; now: Date;
  }): Promise<TaskBatchApplyResult> {
    return this.database.db.transaction(async (tx) => {
      if (!input.groupExists) {
        await tx.insert(actionGroups).values({
          id: input.groupId, workspaceId: input.workspaceId, actorUserId: input.actorUserId,
          ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
          status: "applying", requiresConfirmation: false,
        });
      }

      const persistedTaskTargets = uniqueSorted(input.steps.flatMap((step) =>
        (step.kind === "update" || step.kind === "link") && step.target.kind === "persisted" ? [step.target.taskId] : [],
      ));
      const occurrenceTargets = uniqueSorted(input.steps.flatMap((step) => step.kind === "reschedule" ? [step.occurrenceId] : []));
      const goalTargets = uniqueSorted(input.steps.flatMap((step) => {
        if (step.kind === "link") return [step.goalId];
        if (step.kind === "create" && step.action.goalLink) return [step.action.goalLink.goalId];
        return [];
      }));

      const lockedTasks = persistedTaskTargets.length ? await tx.select().from(tasks).where(and(
        eq(tasks.workspaceId, input.workspaceId), inArray(tasks.id, persistedTaskTargets),
      )).orderBy(tasks.id).for("update") : [];
      const lockedOccurrences = occurrenceTargets.length ? await tx.select({ occurrence: taskOccurrences, task: tasks })
        .from(taskOccurrences)
        .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
        .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), inArray(taskOccurrences.id, occurrenceTargets)))
        .orderBy(taskOccurrences.id).for("update") : [];
      const lockedGoals = goalTargets.length ? await tx.select().from(goals).where(and(
        eq(goals.workspaceId, input.workspaceId), inArray(goals.id, goalTargets),
      )).orderBy(goals.id).for("update") : [];
      if (lockedTasks.length !== persistedTaskTargets.length) throw new Error("batch task target is missing");
      if (lockedOccurrences.length !== occurrenceTargets.length) throw new Error("batch occurrence target is missing");
      if (lockedGoals.length !== goalTargets.length) throw new Error("batch goal target is missing");

      const createdTaskIds = new Map<string, string>();
      const titles: string[] = [];
      const rebuild = new Set<string>();
      for (const step of input.steps) {
        if (step.kind === "create") {
          const plan = step.built.plan;
          await tx.insert(tasks).values(plan.task);
          if (plan.recurrenceExclusions.length) await tx.insert(taskRecurrenceExclusions).values(plan.recurrenceExclusions);
          if (plan.occurrences.length) await tx.insert(taskOccurrences).values(plan.occurrences);
          if (plan.reminderRules.length) await tx.insert(reminderRules).values(plan.reminderRules);
          if (plan.reminderDeliveries.length) await tx.insert(reminderDeliveries).values(plan.reminderDeliveries);
          if (plan.checklist.length) await tx.insert(taskChecklistItems).values(plan.checklist);
          await tx.insert(taskEvents).values({ workspaceId: input.workspaceId, taskId: plan.task.id, actorUserId: input.actorUserId, eventType: "task:created" });
          await tx.insert(actionEvents).values({
            workspaceId: input.workspaceId, groupId: input.groupId, actionType: "create_task", entityType: "task",
            entityId: plan.task.id, postVersion: 1, afterState: { title: plan.task.title },
          });
          createdTaskIds.set(step.stepId, plan.task.id);
          titles.push(plan.task.title);
          if (step.action.goalLink) {
            await insertGoalLink(tx, {
              workspaceId: input.workspaceId, groupId: input.groupId, taskId: plan.task.id,
              goalId: step.action.goalLink.goalId, expectedGoalVersion: step.action.goalLink.expectedGoalVersion,
              source: step.action.source, confidence: step.action.goalLink.confidence,
            });
          }
          continue;
        }
        if (step.kind === "update") {
          const taskId = resolveTaskId(step.target, createdTaskIds);
          const expectedVersion = step.target.kind === "persisted" ? step.target.expectedTaskVersion : 1;
          const [before] = await tx.select().from(tasks).where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, taskId), eq(tasks.version, expectedVersion))).limit(1);
          if (!before) throw new Error(`step ${step.stepId}: task is stale or missing`);
          const beforeChecklist = await tx.select({ text: taskChecklistItems.text, done: taskChecklistItems.done }).from(taskChecklistItems)
            .where(and(eq(taskChecklistItems.workspaceId, input.workspaceId), eq(taskChecklistItems.taskId, taskId))).orderBy(taskChecklistItems.sortOrder);
          const { checklist, ...patch } = step.patch;
          if (patch.habitMode === false) { patch.minimumAction = null; patch.desiredAction = null; patch.habitTrigger = null; }
          const [after] = await tx.update(tasks).set({ ...patch, version: sql`${tasks.version} + 1`, updatedAt: input.now })
            .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, taskId), eq(tasks.version, expectedVersion))).returning();
          if (!after) throw new Error(`step ${step.stepId}: task changed while applying`);
          let afterChecklist = beforeChecklist;
          if (checklist !== undefined) {
            await tx.delete(taskChecklistItems).where(and(eq(taskChecklistItems.workspaceId, input.workspaceId), eq(taskChecklistItems.taskId, taskId)));
            if (checklist.length) await tx.insert(taskChecklistItems).values(checklist.map((item, index) => ({ workspaceId: input.workspaceId, taskId, text: item.text, done: item.done, sortOrder: index })));
            afterChecklist = checklist;
          }
          await tx.insert(taskEvents).values({ workspaceId: input.workspaceId, taskId, actorUserId: input.actorUserId, eventType: "task:updated" });
          await tx.insert(actionEvents).values({ workspaceId: input.workspaceId, groupId: input.groupId, actionType: "update_task", entityType: "task", entityId: taskId, postVersion: after.version, beforeState: { ...taskState(before), checklist: beforeChecklist }, afterState: { ...taskState(after), checklist: afterChecklist } });
          titles.push(after.title);
          continue;
        }
        if (step.kind === "reschedule") {
          const locked = lockedOccurrences.find((row) => row.occurrence.id === step.occurrenceId);
          if (!locked || locked.occurrence.version !== step.expectedVersion) throw new Error(`step ${step.stepId}: occurrence is stale or missing`);
          if (["done", "skipped", "cancelled", "elapsed"].includes(locked.occurrence.status)) throw new Error(`step ${step.stepId}: terminal occurrence cannot be rescheduled`);
          if (locked.occurrence.timezone !== step.scheduleTimezone) throw new Error(`step ${step.stepId}: reschedule timezone mismatch`);
          const prior = await tx.select({ id: taskEvents.id }).from(taskEvents).where(and(eq(taskEvents.workspaceId, input.workspaceId), eq(taskEvents.occurrenceId, step.occurrenceId), eq(taskEvents.eventType, "occurrence:rescheduled")));
          if (isRescheduleReasonRequired(locked.task.importance, prior.length) && !step.reason?.trim()) throw new Error(`step ${step.stepId}: reschedule reason is required`);
          const nextDefinition = rescheduledDefinition(taskDefinitionFromRow(locked.task), step.schedule);
          if (nextDefinition.timeMode === "fuzzy") throw new Error(`step ${step.stepId}: fuzzy batch reschedule is not supported`);
          const [afterOccurrence] = await tx.update(taskOccurrences).set({
            status: rescheduledOccurrenceStatus(nextDefinition, input.now), timezone: step.scheduleTimezone,
            plannedStartAt: step.schedule.plannedStartAt ?? null, plannedEndAt: step.schedule.plannedEndAt ?? null,
            plannedLocalDate: step.schedule.plannedLocalDate ?? null, dueAt: step.schedule.dueAt ?? null, dueLocalDate: step.schedule.dueLocalDate ?? null,
            overdue: false, elapsedAt: null, completedAt: null, completedLate: false, skipReason: null, needsReminderRebuild: true,
            version: sql`${taskOccurrences.version} + 1`, updatedAt: input.now,
          }).where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, step.occurrenceId), eq(taskOccurrences.version, step.expectedVersion))).returning();
          if (!afterOccurrence) throw new Error(`step ${step.stepId}: occurrence changed while applying`);
          await tx.update(reminderDeliveries).set({ status: "cancelled", suppressedReason: "superseded" }).where(and(eq(reminderDeliveries.workspaceId, input.workspaceId), eq(reminderDeliveries.occurrenceId, step.occurrenceId), inArray(reminderDeliveries.status, ["pending", "processing"])));
          await tx.insert(actionEvents).values({ workspaceId: input.workspaceId, groupId: input.groupId, actionType: "reschedule_occurrence", entityType: "occurrence", entityId: step.occurrenceId, postVersion: afterOccurrence.version, beforeState: occurrenceState(locked.occurrence), afterState: occurrenceState(afterOccurrence) });
          if (!locked.task.recurrenceRule) {
            const [afterTask] = await tx.update(tasks).set({
              timeMode: nextDefinition.timeMode, timezone: nextDefinition.timezone,
              plannedStartAt: nextDefinition.plannedStartAt ?? null, plannedEndAt: nextDefinition.plannedEndAt ?? null,
              plannedLocalDate: nextDefinition.plannedLocalDate ?? null, dueAt: nextDefinition.dueAt ?? null, dueLocalDate: nextDefinition.dueLocalDate ?? null,
              fuzzyHorizonText: null, reviewAt: null, version: sql`${tasks.version} + 1`, updatedAt: input.now,
            }).where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, locked.task.id), eq(tasks.version, locked.task.version))).returning();
            if (!afterTask) throw new Error(`step ${step.stepId}: task changed while rescheduling`);
            await tx.insert(actionEvents).values({ workspaceId: input.workspaceId, groupId: input.groupId, actionType: "reschedule_occurrence", entityType: "task", entityId: locked.task.id, postVersion: afterTask.version, beforeState: taskState(locked.task), afterState: taskState(afterTask) });
          }
          await tx.insert(taskEvents).values({ workspaceId: input.workspaceId, taskId: locked.task.id, occurrenceId: step.occurrenceId, actorUserId: input.actorUserId, eventType: "occurrence:rescheduled", ...(step.reason ? { details: step.reason } : {}) });
          rebuild.add(step.occurrenceId); titles.push(locked.task.title);
          continue;
        }
        const taskId = resolveTaskId(step.target, createdTaskIds);
        await insertGoalLink(tx, { workspaceId: input.workspaceId, groupId: input.groupId, taskId, goalId: step.goalId, expectedGoalVersion: step.expectedGoalVersion, source: step.source, confidence: step.confidence });
        const task = await tx.select({ title: tasks.title }).from(tasks).where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, taskId))).limit(1);
        titles.push(task[0]?.title ?? "Связать задачу с целью");
      }

      await tx.delete(pendingActions).where(and(eq(pendingActions.workspaceId, input.workspaceId), eq(pendingActions.groupId, input.groupId)));
      const [finalized] = await tx.update(actionGroups).set({ status: "applied", appliedAt: input.now, undoExpiresAt: input.undoExpiresAt })
        .where(and(eq(actionGroups.workspaceId, input.workspaceId), eq(actionGroups.id, input.groupId), eq(actionGroups.status, "applying"))).returning({ id: actionGroups.id });
      if (!finalized) throw new Error("task batch action group is not claimable");
      return { groupId: input.groupId, count: input.steps.length, titles, reminderRebuildOccurrenceIds: [...rebuild] };
    });
  }

  async undo(input: {
    workspaceId: string; groupId: string; now: Date;
    events: ReadonlyArray<{ actionType: string; entityType: string; entityId: string; postVersion: number | null; beforeState: unknown; afterState: unknown }>;
  }): Promise<{ reminderRebuildOccurrenceIds: string[] }> {
    return this.database.db.transaction(async (tx) => {
      const taskEventsForUndo = input.events.filter((event) => event.entityType === "task" && event.postVersion !== null);
      const occurrenceEventsForUndo = input.events.filter((event) => event.entityType === "occurrence" && event.postVersion !== null);
      const taskExpected = maxVersions(taskEventsForUndo);
      const occurrenceExpected = maxVersions(occurrenceEventsForUndo);
      if (taskExpected.size) {
        const rows = await tx.select({ id: tasks.id, version: tasks.version }).from(tasks).where(and(eq(tasks.workspaceId, input.workspaceId), inArray(tasks.id, [...taskExpected.keys()].sort()))).orderBy(tasks.id).for("update");
        if (rows.length !== taskExpected.size || rows.some((row) => row.version !== taskExpected.get(row.id))) throw new Error("task batch undo refused because a task changed after the batch");
      }
      if (occurrenceExpected.size) {
        const rows = await tx.select({ id: taskOccurrences.id, version: taskOccurrences.version }).from(taskOccurrences).where(and(eq(taskOccurrences.workspaceId, input.workspaceId), inArray(taskOccurrences.id, [...occurrenceExpected.keys()].sort()))).orderBy(taskOccurrences.id).for("update");
        if (rows.length !== occurrenceExpected.size || rows.some((row) => row.version !== occurrenceExpected.get(row.id))) throw new Error("task batch undo refused because an occurrence changed after the batch");
      }

      for (const event of input.events.filter((item) => item.entityType === "task_goal")) {
        const state = event.afterState as { taskId?: string; goalId?: string } | null;
        if (!state?.taskId || !state.goalId) throw new Error("task batch goal-link undo state is incomplete");
        const deleted = await tx.delete(taskGoals).where(and(eq(taskGoals.workspaceId, input.workspaceId), eq(taskGoals.taskId, state.taskId), eq(taskGoals.goalId, state.goalId))).returning({ taskId: taskGoals.taskId });
        if (!deleted.length) throw new Error("task batch goal link changed after the batch");
      }

      const rebuild = new Set<string>();
      const occurrenceRestores = occurrenceEventsForUndo.sort((a, b) => (b.postVersion ?? 0) - (a.postVersion ?? 0));
      for (const event of occurrenceRestores) {
        const state = event.beforeState as ReturnType<typeof occurrenceState> | null;
        if (!state || event.postVersion === null) throw new Error("task batch occurrence undo state is incomplete");
        const [restored] = await tx.update(taskOccurrences).set({
          status: state.status, timezone: state.timezone, plannedStartAt: parseJsonDate(state.plannedStartAt), plannedEndAt: parseJsonDate(state.plannedEndAt),
          plannedLocalDate: state.plannedLocalDate, dueAt: parseJsonDate(state.dueAt), dueLocalDate: state.dueLocalDate, overdue: state.overdue,
          elapsedAt: parseJsonDate(state.elapsedAt), completedAt: parseJsonDate(state.completedAt), completedLate: state.completedLate,
          skipReason: state.skipReason, needsReminderRebuild: true, defaultRemindersSuppressed: state.defaultRemindersSuppressed,
          seriesRevision: state.seriesRevision, version: sql`${taskOccurrences.version} + 1`, updatedAt: input.now,
        }).where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, event.entityId), eq(taskOccurrences.version, event.postVersion))).returning({ id: taskOccurrences.id });
        if (!restored) throw new Error("task batch occurrence changed during undo");
        rebuild.add(event.entityId);
      }

      const nonCreateTaskEvents = taskEventsForUndo.filter((event) => event.actionType !== "create_task").sort((a, b) => (b.postVersion ?? 0) - (a.postVersion ?? 0));
      for (const event of nonCreateTaskEvents) {
        const state = event.beforeState as (ReturnType<typeof taskState> & { checklist?: Array<{ text: string; done: boolean }> }) | null;
        if (!state || event.postVersion === null) throw new Error("task batch task undo state is incomplete");
        const [restored] = await tx.update(tasks).set({
          title: state.title, why: state.why, nextAction: state.nextAction, context: state.context, importance: state.importance,
          status: state.status, timeMode: state.timeMode, timezone: state.timezone, plannedStartAt: parseJsonDate(state.plannedStartAt),
          plannedEndAt: parseJsonDate(state.plannedEndAt), plannedLocalDate: state.plannedLocalDate, dueAt: parseJsonDate(state.dueAt), dueLocalDate: state.dueLocalDate,
          fuzzyHorizonText: state.fuzzyHorizonText, reviewAt: parseJsonDate(state.reviewAt), recurrenceRule: state.recurrenceRule,
          recurrenceTimezone: state.recurrenceTimezone, recurrenceEndLocalDate: state.recurrenceEndLocalDate, missPolicy: state.missPolicy,
          habitMode: state.habitMode, minimumAction: state.minimumAction, desiredAction: state.desiredAction, habitTrigger: state.habitTrigger,
          habitOfferSentAt: parseJsonDate(state.habitOfferSentAt), seriesRevision: state.seriesRevision,
          version: sql`${tasks.version} + 1`, updatedAt: input.now,
        }).where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, event.entityId), eq(tasks.version, event.postVersion))).returning({ id: tasks.id });
        if (!restored) throw new Error("task batch task changed during undo");
        if (state.checklist) {
          await tx.delete(taskChecklistItems).where(and(eq(taskChecklistItems.workspaceId, input.workspaceId), eq(taskChecklistItems.taskId, event.entityId)));
          if (state.checklist.length) await tx.insert(taskChecklistItems).values(state.checklist.map((item, index) => ({ workspaceId: input.workspaceId, taskId: event.entityId, text: item.text, done: item.done, sortOrder: index })));
        }
      }

      const createdTaskIds = taskEventsForUndo.filter((event) => event.actionType === "create_task").map((event) => event.entityId);
      if (createdTaskIds.length) {
        const deleted = await tx.delete(tasks).where(and(eq(tasks.workspaceId, input.workspaceId), inArray(tasks.id, createdTaskIds))).returning({ id: tasks.id });
        if (deleted.length !== new Set(createdTaskIds).size) throw new Error("task batch created task is missing during undo");
      }
      const [group] = await tx.update(actionGroups).set({ status: "undone", undoneAt: input.now }).where(and(eq(actionGroups.workspaceId, input.workspaceId), eq(actionGroups.id, input.groupId), eq(actionGroups.status, "undoing"))).returning({ id: actionGroups.id });
      if (!group) throw new Error("task batch undo group is not in progress");
      return { reminderRebuildOccurrenceIds: [...rebuild] };
    });
  }
}

function resolveTaskId(ref: TaskBatchTaskRef, created: ReadonlyMap<string, string>): string {
  if (ref.kind === "persisted") return ref.taskId;
  const id = created.get(ref.stepId);
  if (!id) throw new Error(`temporary task reference ${ref.stepId} is unavailable`);
  return id;
}

function uniqueSorted(values: readonly string[]): string[] { return [...new Set(values)].sort(); }

function maxVersions(events: readonly { entityId: string; postVersion: number | null }[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const event of events) if (event.postVersion !== null) result.set(event.entityId, Math.max(result.get(event.entityId) ?? 0, event.postVersion));
  return result;
}

function parseJsonDate(value: string | null): Date | null { return value ? new Date(value) : null; }

async function insertGoalLink(tx: any, input: { workspaceId: string; groupId: string; taskId: string; goalId: string; expectedGoalVersion: number; source: "user_explicit" | "ai_inferred"; confidence: number }): Promise<void> {
  const [goal] = await tx.select().from(goals).where(and(eq(goals.workspaceId, input.workspaceId), eq(goals.id, input.goalId), eq(goals.version, input.expectedGoalVersion), eq(goals.status, "active"))).limit(1);
  const [task] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, input.taskId))).limit(1);
  if (!goal || !task) throw new Error("batch task or goal is stale or missing");
  const [link] = await tx.insert(taskGoals).values({ workspaceId: input.workspaceId, taskId: input.taskId, goalId: input.goalId, source: input.source, confidence: Math.round(input.confidence * 100) }).onConflictDoNothing().returning();
  if (!link) throw new Error("task is already linked to this goal");
  await tx.insert(actionEvents).values({ workspaceId: input.workspaceId, groupId: input.groupId, actionType: "link_task_to_goal", entityType: "task_goal", entityId: input.taskId, afterState: { taskId: input.taskId, goalId: input.goalId } });
}

function taskState(row: typeof tasks.$inferSelect) {
  return {
    title: row.title, why: row.why, nextAction: row.nextAction, context: row.context, importance: row.importance, status: row.status,
    timeMode: row.timeMode, timezone: row.timezone, plannedStartAt: row.plannedStartAt?.toISOString() ?? null,
    plannedEndAt: row.plannedEndAt?.toISOString() ?? null, plannedLocalDate: row.plannedLocalDate, dueAt: row.dueAt?.toISOString() ?? null,
    dueLocalDate: row.dueLocalDate, fuzzyHorizonText: row.fuzzyHorizonText, reviewAt: row.reviewAt?.toISOString() ?? null,
    recurrenceRule: row.recurrenceRule, recurrenceTimezone: row.recurrenceTimezone, recurrenceEndLocalDate: row.recurrenceEndLocalDate,
    recurrenceExcludedLocalDates: [], missPolicy: row.missPolicy, habitMode: row.habitMode, minimumAction: row.minimumAction,
    desiredAction: row.desiredAction, habitTrigger: row.habitTrigger, habitOfferSentAt: row.habitOfferSentAt?.toISOString() ?? null,
    seriesRevision: row.seriesRevision,
  };
}

function occurrenceState(row: typeof taskOccurrences.$inferSelect) {
  return {
    status: row.status, timezone: row.timezone, plannedStartAt: row.plannedStartAt?.toISOString() ?? null,
    plannedEndAt: row.plannedEndAt?.toISOString() ?? null, plannedLocalDate: row.plannedLocalDate,
    dueAt: row.dueAt?.toISOString() ?? null, dueLocalDate: row.dueLocalDate, overdue: row.overdue,
    elapsedAt: row.elapsedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null,
    completedLate: row.completedLate, skipReason: row.skipReason, needsReminderRebuild: row.needsReminderRebuild,
    defaultRemindersSuppressed: row.defaultRemindersSuppressed, seriesRevision: row.seriesRevision,
  };
}
