import { Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { RescheduleFields } from "../core/reschedule.js";
import type { ReminderRuleSpec } from "../core/reminder-planning.js";
import type { TaskDefinition, TimeMode } from "../core/types.js";
import { DatabaseService } from "../database/database.service.js";
import {
  actionEvents,
  actionGroups,
  goals,
  memoryItems,
  pendingActions,
  reminderDeliveries,
  reminderRules,
  taskGoals,
  taskOccurrences,
  taskRecurrenceExclusions,
  tasks,
  userSettings,
} from "../database/schema.js";
import { insertTaskPlan, type PersistedTaskPlan } from "../tasks/tasks.repository.js";
import {
  cancelTaskInTx,
  changeReminderInTx,
  changeSeriesInTx,
  completeOccurrenceInTx,
  completeTaskInTx,
  concretiseTaskInTx,
  parseJsonDate,
  replaceChecklist,
  rescheduleOccurrenceInTx,
  updateOccurrenceInTx,
  updateSettingsInTx,
  updateTaskInTx,
  type CancelTaskStepResult,
  type ChangeReminderStepResult,
  type ChangeSeriesStepResult,
  type CompleteTaskStepResult,
  type ConcretiseTaskStepResult,
  type DbTransaction,
  type OccurrenceMutableState,
  type RescheduleOccurrenceStepResult,
  type SettingsMutableState,
  type SettingsOperation,
  type SettingsPatch,
  type TaskMutableState,
  type TouchedVersion,
  type UpdateOccurrenceStepResult,
  type UpdateSettingsStepResult,
  type UpdateTaskPatch,
  type UpdateTaskStepResult,
} from "./action-mutations.repository.js";
import {
  createGoalInTx,
  deleteMemoryInTx,
  goalPlanInTx,
  linkTaskToGoalInTx,
  saveMemoryInTx,
  unlinkTaskToGoalInTx,
  updateGoalInTx,
  updateMemoryInTx,
  type CreateGoalStepResult,
  type DeleteMemoryStepResult,
  type GoalPlanStepResult,
  type GoalState,
  type LinkSource,
  type LinkTaskToGoalStepResult,
  type MemoryState,
  type MemoryType,
  type SaveMemoryStepResult,
  type UnlinkTaskToGoalStepResult,
  type UpdateGoalStepResult,
  type UpdateMemoryStepResult,
} from "../context/context-actions.repository.js";
import { DomainRuleError } from "../core/errors.js";

/**
 * One step of an action group. Every step names the row versions the resolver read; the group
 * applies the steps in order inside one transaction, so a step may address a row an earlier step
 * of the same group changed — the group carries the row forward and only a concurrent writer
 * makes the expectation stale.
 */
export type ActionGroupStep =
  | { kind: "create_task"; plan: PersistedTaskPlan; goalLink: { goalId: string; goalVersion: number; source: LinkSource; confidence: number } | null }
  | { kind: "update_task"; taskId: string; expectedVersion: number; patch: UpdateTaskPatch }
  | { kind: "update_occurrence"; occurrenceId: string; expectedVersion: number; operation: "skip" | "cancel" }
  | { kind: "complete_task"; taskId: string; expectedVersion: number }
  | { kind: "complete_occurrence"; occurrenceId: string; expectedVersion: number }
  | { kind: "cancel_task"; taskId: string; expectedVersion: number }
  | { kind: "reschedule_occurrence"; occurrenceId: string; expectedVersion: number; scheduleTimezone: string; schedule: RescheduleFields; timeMode?: TimeMode; reason?: string }
  | {
      kind: "concretise_task";
      taskId: string;
      expectedVersion: number;
      definition: TaskDefinition;
      occurrenceStatus: "scheduled" | "open";
      explicitReminder?: ReminderRuleSpec;
      reason?: string;
    }
  | { kind: "change_reminder"; occurrenceId: string; expectedVersion: number; mode: "add" | "replace" | "clear"; rule?: ReminderRuleSpec }
  | { kind: "change_series"; taskId: string; expectedVersion: number; operation: "pause" | "resume" | "cancel" | "edit"; editDefinition?: TaskDefinition }
  | { kind: "create_goal"; title: string; why?: string; targetLocalDate?: string }
  | {
      kind: "update_goal";
      goalId: string;
      expectedVersion: number;
      patch: { title?: string; why?: string; targetLocalDate?: string; status?: "active" | "paused" | "completed" | "cancelled"; reviewEnabled?: boolean };
    }
  | { kind: "link_task_to_goal"; taskId: string; expectedTaskVersion: number; goalId: string; expectedGoalVersion: number; source: LinkSource; confidence: number }
  | { kind: "unlink_task_to_goal"; taskId: string; expectedTaskVersion: number; goalId: string; expectedGoalVersion: number }
  | { kind: "goal_plan"; goal: { title: string; why?: string; targetLocalDate?: string }; plans: PersistedTaskPlan[]; source: LinkSource }
  | { kind: "save_memory"; memoryType: MemoryType; content: string; sensitive: boolean; source: LinkSource }
  | { kind: "update_memory"; memoryId: string; expectedVersion: number; patch: { content?: string; sensitive?: boolean } }
  | { kind: "delete_memory"; memoryId: string; expectedVersion: number }
  | { kind: "update_settings"; expectedVersion: number; patch: SettingsPatch; operation?: SettingsOperation };

export interface CreateTaskStepResult {
  kind: "create_task";
  taskId: string;
  title: string;
  goalTitle: string | null;
}

/** What each step persisted, enough to render the applied report without another query. */
export type ActionGroupStepResult =
  | CreateTaskStepResult
  | UpdateTaskStepResult
  | UpdateOccurrenceStepResult
  | CompleteTaskStepResult
  | CancelTaskStepResult
  | RescheduleOccurrenceStepResult
  | ConcretiseTaskStepResult
  | ChangeReminderStepResult
  | ChangeSeriesStepResult
  | CreateGoalStepResult
  | UpdateGoalStepResult
  | LinkTaskToGoalStepResult
  | UnlinkTaskToGoalStepResult
  | GoalPlanStepResult
  | SaveMemoryStepResult
  | UpdateMemoryStepResult
  | DeleteMemoryStepResult
  | UpdateSettingsStepResult;

export interface ActionGroupApplyResult {
  groupId: string;
  steps: ActionGroupStepResult[];
  /** Occurrences whose deliveries must be rebuilt after commit. */
  reminderRebuildOccurrenceIds: string[];
  /** Fuzzy tasks whose planning review must be rebuilt after commit. */
  fuzzyRebuildTaskIds: string[];
  /** Recurring tasks whose projection must be reconciled after commit. */
  reconcileTaskIds: string[];
  createdTaskIds: string[];
  /** Plans persisted by this group; their pending deliveries still need enqueueing. */
  preparedPlans: PersistedTaskPlan[];
}

export interface ActionGroupUndoResult {
  reminderRebuildOccurrenceIds: string[];
  fuzzyRebuildTaskIds: string[];
  reconcileTaskIds: string[];
}

interface UndoEvent {
  actionType: string;
  entityType: string;
  entityId: string;
  postVersion: number | null;
  beforeState: unknown;
  afterState: unknown;
}

const CREATE_ACTIONS = new Set(["create_task", "create_goal_plan", "goal_plan", "create_goal", "save_memory", "occurrence_created"]);
const REBUILD_ACTIONS = new Set(["reschedule_occurrence", "change_reminder", "change_series"]);

/** One PostgreSQL transaction per action group: every step commits with its journal or nothing does. */
@Injectable()
export class ActionGroupRepository {
  constructor(private readonly database: DatabaseService) {}

  async apply(input: {
    workspaceId: string;
    actorUserId: string;
    groupId: string;
    groupExists: boolean;
    sourceMessageId?: string;
    steps: readonly ActionGroupStep[];
    now: Date;
    undoExpiresAt: Date;
  }): Promise<ActionGroupApplyResult> {
    return this.database.db.transaction(async (tx) => {
      if (!input.groupExists) {
        await tx.insert(actionGroups).values({
          id: input.groupId,
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
          status: "applying",
          requiresConfirmation: false,
          createdAt: input.now,
        });
      }
      const versions = await lockTargets(tx, input.workspaceId, input.actorUserId, input.steps);
      const scope = { workspaceId: input.workspaceId, groupId: input.groupId, actorUserId: input.actorUserId, now: input.now };
      const result: ActionGroupApplyResult = {
        groupId: input.groupId,
        steps: [],
        reminderRebuildOccurrenceIds: [],
        fuzzyRebuildTaskIds: [],
        reconcileTaskIds: [],
        createdTaskIds: [],
        preparedPlans: [],
      };
      const rebuild = new Set<string>();
      const reconcile = new Set<string>();

      for (const step of input.steps) {
        switch (step.kind) {
          case "create_task": {
            await insertTaskPlan(tx, step.plan);
            versions.created("task", step.plan.task.id, 1);
            await tx.insert(actionEvents).values({
              workspaceId: input.workspaceId,
              groupId: input.groupId,
              actionType: "create_task",
              entityType: "task",
              entityId: step.plan.task.id,
              postVersion: 1,
              afterState: { title: step.plan.task.title },
            });
            let goalTitle: string | null = null;
            if (step.goalLink) {
              const link = await linkTaskToGoalInTx(tx, {
                ...scope,
                taskId: step.plan.task.id,
                expectedTaskVersion: 1,
                goalId: step.goalLink.goalId,
                expectedGoalVersion: versions.expect("goal", step.goalLink.goalId, step.goalLink.goalVersion),
                source: step.goalLink.source,
                confidence: step.goalLink.confidence,
              });
              goalTitle = link.goalTitle;
            }
            result.createdTaskIds.push(step.plan.task.id);
            result.preparedPlans.push(step.plan);
            result.steps.push({ kind: "create_task", taskId: step.plan.task.id, title: step.plan.task.title, goalTitle });
            break;
          }
          case "update_task": {
            const { touched, ...stepResult } = await updateTaskInTx(tx, {
              ...scope,
              taskId: step.taskId,
              expectedVersion: versions.expect("task", step.taskId, step.expectedVersion),
              patch: step.patch,
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
          case "update_occurrence": {
            const { touched, ...stepResult } = await updateOccurrenceInTx(tx, {
              ...scope,
              occurrenceId: step.occurrenceId,
              expectedVersion: versions.expect("occurrence", step.occurrenceId, step.expectedVersion),
              operation: step.operation,
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
          case "complete_task": {
            const { touched, ...stepResult } = await completeTaskInTx(tx, {
              ...scope,
              taskId: step.taskId,
              expectedVersion: versions.expect("task", step.taskId, step.expectedVersion),
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
          case "complete_occurrence": {
            const { touched, ...stepResult } = await completeOccurrenceInTx(tx, {
              ...scope,
              occurrenceId: step.occurrenceId,
              expectedVersion: versions.expect("occurrence", step.occurrenceId, step.expectedVersion),
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
          case "cancel_task": {
            const { touched, ...stepResult } = await cancelTaskInTx(tx, {
              ...scope,
              taskId: step.taskId,
              expectedVersion: versions.expect("task", step.taskId, step.expectedVersion),
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
          case "reschedule_occurrence": {
            const { touched, ...stepResult } = await rescheduleOccurrenceInTx(tx, {
              ...scope,
              occurrenceId: step.occurrenceId,
              expectedVersion: versions.expect("occurrence", step.occurrenceId, step.expectedVersion),
              scheduleTimezone: step.scheduleTimezone,
              schedule: step.schedule,
              ...(step.timeMode ? { timeMode: step.timeMode } : {}),
              ...(step.reason !== undefined ? { reason: step.reason } : {}),
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            if (!stepResult.becameFuzzy) rebuild.add(step.occurrenceId);
            break;
          }
          case "concretise_task": {
            const { touched, ...stepResult } = await concretiseTaskInTx(tx, {
              ...scope,
              taskId: step.taskId,
              expectedVersion: versions.expect("task", step.taskId, step.expectedVersion),
              definition: step.definition,
              occurrenceStatus: step.occurrenceStatus,
              ...(step.explicitReminder ? { explicitReminder: step.explicitReminder } : {}),
              ...(step.reason !== undefined ? { reason: step.reason } : {}),
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            rebuild.add(stepResult.occurrenceId);
            break;
          }
          case "change_reminder": {
            const { touched, ...stepResult } = await changeReminderInTx(tx, {
              ...scope,
              occurrenceId: step.occurrenceId,
              expectedVersion: versions.expect("occurrence", step.occurrenceId, step.expectedVersion),
              mode: step.mode,
              ...(step.rule ? { rule: step.rule } : {}),
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            rebuild.add(step.occurrenceId);
            break;
          }
          case "change_series": {
            const { touched, ...stepResult } = await changeSeriesInTx(tx, {
              ...scope,
              taskId: step.taskId,
              expectedVersion: versions.expect("task", step.taskId, step.expectedVersion),
              operation: step.operation,
              ...(step.editDefinition ? { editDefinition: step.editDefinition } : {}),
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            if (stepResult.reconcile) reconcile.add(step.taskId);
            break;
          }
          case "create_goal": {
            const { touched, ...stepResult } = await createGoalInTx(tx, {
              ...scope,
              title: step.title,
              ...(step.why !== undefined ? { why: step.why } : {}),
              ...(step.targetLocalDate !== undefined ? { targetLocalDate: step.targetLocalDate } : {}),
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
          case "update_goal": {
            const { touched, ...stepResult } = await updateGoalInTx(tx, {
              ...scope,
              goalId: step.goalId,
              expectedVersion: versions.expect("goal", step.goalId, step.expectedVersion),
              patch: step.patch,
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
          case "link_task_to_goal": {
            const { touched, ...stepResult } = await linkTaskToGoalInTx(tx, {
              ...scope,
              taskId: step.taskId,
              expectedTaskVersion: versions.expect("task", step.taskId, step.expectedTaskVersion),
              goalId: step.goalId,
              expectedGoalVersion: versions.expect("goal", step.goalId, step.expectedGoalVersion),
              source: step.source,
              confidence: step.confidence,
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
          case "unlink_task_to_goal": {
            const { touched, ...stepResult } = await unlinkTaskToGoalInTx(tx, {
              ...scope,
              taskId: step.taskId,
              expectedTaskVersion: versions.expect("task", step.taskId, step.expectedTaskVersion),
              goalId: step.goalId,
              expectedGoalVersion: versions.expect("goal", step.goalId, step.expectedGoalVersion),
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
          case "goal_plan": {
            const { touched, ...stepResult } = await goalPlanInTx(tx, { ...scope, goal: step.goal, plans: step.plans, source: step.source });
            for (const item of touched) versions.created(item.entity, item.id, item.version);
            result.steps.push(stepResult);
            result.createdTaskIds.push(...stepResult.taskIds);
            result.preparedPlans.push(...step.plans);
            break;
          }
          case "save_memory": {
            const { touched, ...stepResult } = await saveMemoryInTx(tx, {
              ...scope,
              memoryType: step.memoryType,
              content: step.content,
              sensitive: step.sensitive,
              source: step.source,
              ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
          case "update_memory": {
            const { touched, ...stepResult } = await updateMemoryInTx(tx, {
              ...scope,
              memoryId: step.memoryId,
              expectedVersion: versions.expect("memory", step.memoryId, step.expectedVersion),
              patch: step.patch,
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
          case "delete_memory": {
            const { touched, ...stepResult } = await deleteMemoryInTx(tx, {
              ...scope,
              memoryId: step.memoryId,
              expectedVersion: versions.expect("memory", step.memoryId, step.expectedVersion),
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
          case "update_settings": {
            const { touched, ...stepResult } = await updateSettingsInTx(tx, {
              ...scope,
              expectedVersion: versions.expect("settings", input.actorUserId, step.expectedVersion),
              patch: step.patch,
              ...(step.operation ? { operation: step.operation } : {}),
            });
            versions.bump(touched);
            result.steps.push(stepResult);
            break;
          }
        }
      }

      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt, input.now);
      result.reminderRebuildOccurrenceIds = [...rebuild];
      result.reconcileTaskIds = [...reconcile];
      return result;
    });
  }

  /**
   * Reverses every journal entry of a claimed group in one transaction. Each entity is restored
   * to its earliest snapshot in the group and rows the group created are removed; any row that
   * changed after the group refuses the undo, so the journal never claims a rollback it cannot do.
   */
  async undo(input: { workspaceId: string; groupId: string; now: Date }): Promise<ActionGroupUndoResult> {
    return this.database.db.transaction(async (tx) => {
      const events: UndoEvent[] = await tx
        .select()
        .from(actionEvents)
        .where(and(eq(actionEvents.workspaceId, input.workspaceId), eq(actionEvents.groupId, input.groupId)));
      const rebuild = new Set<string>();
      const fuzzyRebuild = new Set<string>();
      const reconcile = new Set<string>();

      const byEntity = (entityType: string) => {
        const map = new Map<string, UndoEvent[]>();
        for (const event of events) {
          if (event.entityType !== entityType) continue;
          const list = map.get(event.entityId) ?? [];
          list.push(event);
          map.set(event.entityId, list);
        }
        for (const list of map.values()) list.sort((a, b) => (a.postVersion ?? 0) - (b.postVersion ?? 0));
        return map;
      };
      const taskEvents = byEntity("task");
      const occurrenceEvents = byEntity("occurrence");
      const goalEvents = byEntity("goal");
      const memoryEvents = byEntity("memory");
      const settingsEvents = byEntity("settings");
      const linkEvents = events.filter((event) => event.entityType === "task_goal");
      const known = new Set(["task", "occurrence", "goal", "memory", "settings", "task_goal"]);
      for (const event of events) if (!known.has(event.entityType)) throw new Error(`unsupported undo entity ${event.entityType}`);

      const versions = new VersionTracker();
      const lockAndVerify = async (
        entity: TouchedVersion["entity"],
        grouped: Map<string, UndoEvent[]>,
        loader: (ids: string[]) => Promise<Array<{ id: string; version: number }>>,
      ) => {
        const ids = [...grouped.keys()].sort();
        if (!ids.length) return;
        const rows = await loader(ids);
        for (const row of rows) versions.register(entity, row.id, row.version);
        for (const id of ids) {
          const expected = Math.max(...(grouped.get(id) ?? []).map((event) => event.postVersion ?? 0));
          const row = rows.find((item) => item.id === id);
          if (!row) throw new DomainRuleError(`undo refused because a ${entity} is missing`);
          if (row.version !== expected) throw new DomainRuleError(`undo refused because a ${entity} changed after the action`);
        }
      };
      await lockAndVerify("task", taskEvents, (ids) =>
        tx
          .select({ id: tasks.id, version: tasks.version })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, input.workspaceId), inArray(tasks.id, ids)))
          .orderBy(tasks.id)
          .for("update"),
      );
      await lockAndVerify("occurrence", occurrenceEvents, (ids) =>
        tx
          .select({ id: taskOccurrences.id, version: taskOccurrences.version })
          .from(taskOccurrences)
          .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), inArray(taskOccurrences.id, ids)))
          .orderBy(taskOccurrences.id)
          .for("update"),
      );
      await lockAndVerify("goal", goalEvents, (ids) =>
        tx
          .select({ id: goals.id, version: goals.version })
          .from(goals)
          .where(and(eq(goals.workspaceId, input.workspaceId), inArray(goals.id, ids)))
          .orderBy(goals.id)
          .for("update"),
      );
      const restorableMemory = new Map([...memoryEvents].filter(([, list]) => !list.every((event) => event.actionType === "delete_memory")));
      await lockAndVerify("memory", restorableMemory, (ids) =>
        tx
          .select({ id: memoryItems.id, version: memoryItems.version })
          .from(memoryItems)
          .where(and(eq(memoryItems.workspaceId, input.workspaceId), inArray(memoryItems.id, ids)))
          .orderBy(memoryItems.id)
          .for("update"),
      );
      await lockAndVerify("settings", settingsEvents, (ids) =>
        tx
          .select({ id: userSettings.userId, version: userSettings.version })
          .from(userSettings)
          .where(inArray(userSettings.userId, ids))
          .orderBy(userSettings.userId)
          .for("update"),
      );

      // Links first: a created task or goal is deleted below and cascades its links anyway.
      for (const [key, list] of groupPairs(linkEvents)) {
        const [taskId, goalId] = key.split(":") as [string, string];
        const linked = list.some((event) => event.actionType !== "unlink_task_to_goal");
        const unlinked = list.some((event) => event.actionType === "unlink_task_to_goal");
        if (linked && !unlinked) {
          const deleted = await tx
            .delete(taskGoals)
            .where(and(eq(taskGoals.workspaceId, input.workspaceId), eq(taskGoals.taskId, taskId), eq(taskGoals.goalId, goalId)))
            .returning({ taskId: taskGoals.taskId });
          if (!deleted.length) throw new DomainRuleError("task-goal link changed after the action");
        } else if (unlinked && !linked) {
          const state = list.find((event) => event.actionType === "unlink_task_to_goal")?.beforeState as { source?: string; confidence?: number } | null;
          if (!state?.source) throw new DomainRuleError("task-goal undo state is missing");
          const [restored] = await tx
            .insert(taskGoals)
            .values({ workspaceId: input.workspaceId, taskId, goalId, source: state.source, confidence: state.confidence ?? 100 })
            .onConflictDoNothing()
            .returning({ taskId: taskGoals.taskId });
          if (!restored) throw new DomainRuleError("task-goal link changed after the action");
        }
      }

      for (const [occurrenceId, list] of occurrenceEvents) {
        if (list.some((event) => CREATE_ACTIONS.has(event.actionType))) {
          const deleted = await tx
            .delete(taskOccurrences)
            .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, occurrenceId)))
            .returning({ id: taskOccurrences.id });
          if (!deleted.length) throw new DomainRuleError("created occurrence is missing during undo");
          continue;
        }
        const earliest = list[0]!;
        const state = earliest.beforeState as (OccurrenceMutableState & { explicitReminderRuleIds?: string[]; systemFollowUpRuleIds?: string[] }) | null;
        if (!state || typeof state !== "object") throw new DomainRuleError("undo state is incomplete");
        const actionTypes = new Set(list.map((event) => event.actionType));
        if (actionTypes.has("change_reminder")) {
          await tx
            .update(reminderRules)
            .set({ active: false })
            .where(
              and(
                eq(reminderRules.workspaceId, input.workspaceId),
                eq(reminderRules.occurrenceId, occurrenceId),
                eq(reminderRules.origin, "explicit"),
                eq(reminderRules.active, true),
              ),
            );
          if (state.explicitReminderRuleIds?.length)
            await tx
              .update(reminderRules)
              .set({ active: true })
              .where(and(eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, state.explicitReminderRuleIds)));
          await tx
            .update(reminderDeliveries)
            .set({ status: "cancelled", suppressedReason: "superseded" })
            .where(
              and(
                eq(reminderDeliveries.workspaceId, input.workspaceId),
                eq(reminderDeliveries.occurrenceId, occurrenceId),
                inArray(reminderDeliveries.status, ["pending", "processing"]),
              ),
            );
        }
        const needsRebuild = [...actionTypes].some((type) => REBUILD_ACTIONS.has(type));
        const current = versions.current("occurrence", occurrenceId);
        const [restored] = await tx
          .update(taskOccurrences)
          .set({
            status: state.status,
            timezone: state.timezone,
            plannedStartAt: parseJsonDate(state.plannedStartAt),
            plannedEndAt: parseJsonDate(state.plannedEndAt),
            plannedLocalDate: state.plannedLocalDate,
            dueAt: parseJsonDate(state.dueAt),
            dueLocalDate: state.dueLocalDate,
            overdue: state.overdue,
            elapsedAt: parseJsonDate(state.elapsedAt),
            completedAt: parseJsonDate(state.completedAt),
            completedLate: state.completedLate,
            skipReason: state.skipReason,
            needsReminderRebuild: needsRebuild ? true : state.needsReminderRebuild,
            defaultRemindersSuppressed: state.defaultRemindersSuppressed,
            seriesRevision: state.seriesRevision,
            version: sql`${taskOccurrences.version} + 1`,
            updatedAt: input.now,
          })
          .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, occurrenceId), eq(taskOccurrences.version, current)))
          .returning({ id: taskOccurrences.id });
        if (!restored) throw new DomainRuleError("undo target occurrence changed after action");
        const followUpIds = list.flatMap((event) => (event.beforeState as { systemFollowUpRuleIds?: string[] } | null)?.systemFollowUpRuleIds ?? []);
        if (actionTypes.has("update_occurrence") && followUpIds.length) {
          await tx
            .update(reminderRules)
            .set({ active: true })
            .where(and(eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, followUpIds)));
          await tx
            .update(reminderDeliveries)
            .set({ status: "pending", suppressedReason: null })
            .where(
              and(
                eq(reminderDeliveries.workspaceId, input.workspaceId),
                eq(reminderDeliveries.occurrenceId, occurrenceId),
                inArray(reminderDeliveries.reminderRuleId, followUpIds),
                eq(reminderDeliveries.status, "cancelled"),
                sql`${reminderDeliveries.scheduledFor} > ${input.now}`,
              ),
            );
        }
        if (needsRebuild) rebuild.add(occurrenceId);
        if (actionTypes.has("complete_occurrence") || actionTypes.has("update_occurrence")) {
          await tx
            .update(reminderDeliveries)
            .set({ status: "pending", suppressedReason: null })
            .where(
              and(
                eq(reminderDeliveries.workspaceId, input.workspaceId),
                eq(reminderDeliveries.occurrenceId, occurrenceId),
                eq(reminderDeliveries.status, "suppressed"),
                eq(reminderDeliveries.suppressedReason, "no_longer_applicable"),
                sql`${reminderDeliveries.scheduledFor} > ${input.now}`,
              ),
            );
        }
      }

      for (const [taskId, list] of taskEvents) {
        if (list.some((event) => CREATE_ACTIONS.has(event.actionType))) {
          const deleted = await tx
            .delete(tasks)
            .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, taskId)))
            .returning({ id: tasks.id });
          if (!deleted.length) throw new DomainRuleError("created task is missing during undo");
          continue;
        }
        const earliest = list[0]!;
        const state = earliest.beforeState as (TaskMutableState & { checklist?: Array<{ text: string; done: boolean }>; planningReviewRuleIds?: string[] }) | null;
        if (!state || typeof state !== "object") throw new DomainRuleError("undo state is incomplete");
        const actionTypes = new Set(list.map((event) => event.actionType));
        if (actionTypes.has("change_series")) {
          const newerRevision = await tx
            .select()
            .from(taskOccurrences)
            .where(
              and(
                eq(taskOccurrences.workspaceId, input.workspaceId),
                eq(taskOccurrences.taskId, taskId),
                sql`${taskOccurrences.seriesRevision} <> ${state.seriesRevision}`,
                inArray(taskOccurrences.status, ["scheduled", "open", "in_progress"]),
              ),
            );
          if (newerRevision.some((row) => row.version !== 1 || row.status === "in_progress"))
            throw new DomainRuleError("undo blocked because a new-series occurrence changed after the edit");
          if (newerRevision.length) {
            const ids = newerRevision.map((row) => row.id);
            await tx
              .update(taskOccurrences)
              .set({ status: "cancelled", skipReason: "series_edit_undone", version: sql`${taskOccurrences.version} + 1`, updatedAt: input.now })
              .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), inArray(taskOccurrences.id, ids)));
            await tx
              .update(reminderDeliveries)
              .set({ status: "cancelled", suppressedReason: "superseded" })
              .where(
                and(
                  eq(reminderDeliveries.workspaceId, input.workspaceId),
                  inArray(reminderDeliveries.occurrenceId, ids),
                  inArray(reminderDeliveries.status, ["pending", "processing"]),
                ),
              );
          }
        }
        const current = versions.current("task", taskId);
        const [restored] = await tx
          .update(tasks)
          .set({
            title: state.title,
            why: state.why,
            nextAction: state.nextAction,
            context: state.context,
            importance: state.importance,
            status: state.status,
            timeMode: state.timeMode,
            timezone: state.timezone,
            plannedStartAt: parseJsonDate(state.plannedStartAt),
            plannedEndAt: parseJsonDate(state.plannedEndAt),
            plannedLocalDate: state.plannedLocalDate,
            dueAt: parseJsonDate(state.dueAt),
            dueLocalDate: state.dueLocalDate,
            fuzzyHorizonText: state.fuzzyHorizonText,
            reviewAt: parseJsonDate(state.reviewAt),
            recurrenceRule: state.recurrenceRule,
            recurrenceTimezone: state.recurrenceTimezone,
            recurrenceEndLocalDate: state.recurrenceEndLocalDate,
            missPolicy: state.missPolicy,
            habitOfferSentAt: parseJsonDate(state.habitOfferSentAt),
            seriesRevision: state.seriesRevision,
            version: sql`${tasks.version} + 1`,
            updatedAt: input.now,
          })
          .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, taskId), eq(tasks.version, current)))
          .returning({ id: tasks.id });
        if (!restored) throw new DomainRuleError("undo target task changed after action");
        if (actionTypes.has("change_series")) {
          await tx.delete(taskRecurrenceExclusions).where(and(eq(taskRecurrenceExclusions.workspaceId, input.workspaceId), eq(taskRecurrenceExclusions.taskId, taskId)));
          if (state.recurrenceExcludedLocalDates?.length) {
            await tx.insert(taskRecurrenceExclusions).values(state.recurrenceExcludedLocalDates.map((localDate) => ({ workspaceId: input.workspaceId, taskId, localDate })));
          }
          reconcile.add(taskId);
        }
        const checklistEvent = list.find((event) => Array.isArray((event.beforeState as { checklist?: unknown } | null)?.checklist));
        // Undo restores the recorded state literally: an item the group ticked must come back
        // unticked, so the "keep what the user already did" merge is off here.
        if (checklistEvent)
          await replaceChecklist(tx, input.workspaceId, taskId, (checklistEvent.beforeState as { checklist: Array<{ text: string; done: boolean }> }).checklist, {
            preserveDone: false,
          });
        const insertedRuleIds = list.flatMap((event) => (event.afterState as { insertedRuleIds?: string[] } | null)?.insertedRuleIds ?? []);
        if (insertedRuleIds.length) await tx.delete(reminderRules).where(and(eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, insertedRuleIds)));
        const planningReviewRuleIds = list.flatMap((event) => (event.beforeState as { planningReviewRuleIds?: string[] } | null)?.planningReviewRuleIds ?? []);
        if (planningReviewRuleIds.length) {
          await tx
            .update(reminderRules)
            .set({ active: true })
            .where(and(eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, planningReviewRuleIds)));
          await tx
            .update(reminderDeliveries)
            .set({ status: "pending", suppressedReason: null })
            .where(
              and(
                eq(reminderDeliveries.workspaceId, input.workspaceId),
                inArray(reminderDeliveries.reminderRuleId, planningReviewRuleIds),
                eq(reminderDeliveries.status, "suppressed"),
                eq(reminderDeliveries.suppressedReason, "no_longer_applicable"),
                sql`${reminderDeliveries.scheduledFor} > ${input.now}`,
              ),
            );
        }
        if (actionTypes.has("cancel_task") || actionTypes.has("concretise_task")) fuzzyRebuild.add(taskId);
      }

      for (const [goalId, list] of goalEvents) {
        if (list.some((event) => CREATE_ACTIONS.has(event.actionType))) {
          const deleted = await tx
            .delete(goals)
            .where(and(eq(goals.workspaceId, input.workspaceId), eq(goals.id, goalId)))
            .returning({ id: goals.id });
          if (!deleted.length) throw new DomainRuleError("created goal is missing during undo");
          continue;
        }
        const state = list[0]!.beforeState as GoalState | null;
        if (!state) throw new DomainRuleError("goal undo state is missing");
        const current = versions.current("goal", goalId);
        const [restored] = await tx
          .update(goals)
          .set({
            title: state.title,
            why: state.why,
            status: state.status,
            targetLocalDate: state.targetLocalDate,
            reviewEnabled: state.reviewEnabled,
            nextReviewAt: parseJsonDate(state.nextReviewAt),
            version: current + 1,
            updatedAt: input.now,
          })
          .where(and(eq(goals.workspaceId, input.workspaceId), eq(goals.id, goalId), eq(goals.version, current)))
          .returning({ id: goals.id });
        if (!restored) throw new DomainRuleError("goal changed after action");
      }

      for (const [memoryId, list] of memoryEvents) {
        if (list.every((event) => event.actionType === "delete_memory")) {
          const state = list[0]!.beforeState as MemoryState | null;
          if (!state) throw new DomainRuleError("deleted memory state is missing");
          await tx.insert(memoryItems).values({
            id: memoryId,
            workspaceId: input.workspaceId,
            userId: state.userId,
            type: state.type,
            content: state.content,
            sensitive: state.sensitive,
            source: state.source,
            ...(state.sourceMessageId ? { sourceMessageId: state.sourceMessageId } : {}),
            version: state.version + 1,
            createdAt: new Date(state.createdAt),
            updatedAt: input.now,
          });
          continue;
        }
        if (list.some((event) => CREATE_ACTIONS.has(event.actionType))) {
          const deleted = await tx
            .delete(memoryItems)
            .where(and(eq(memoryItems.workspaceId, input.workspaceId), eq(memoryItems.id, memoryId)))
            .returning({ id: memoryItems.id });
          if (!deleted.length) throw new DomainRuleError("memory changed after action");
          continue;
        }
        const state = list[0]!.beforeState as MemoryState | null;
        if (!state) throw new DomainRuleError("memory undo state is missing");
        const current = versions.current("memory", memoryId);
        const [restored] = await tx
          .update(memoryItems)
          .set({ content: state.content, sensitive: state.sensitive, version: current + 1, updatedAt: input.now })
          .where(and(eq(memoryItems.workspaceId, input.workspaceId), eq(memoryItems.id, memoryId), eq(memoryItems.version, current)))
          .returning({ id: memoryItems.id });
        if (!restored) throw new DomainRuleError("memory changed after action");
      }

      for (const [userId, list] of settingsEvents) {
        const state = list[0]!.beforeState as SettingsMutableState | null;
        if (!state) throw new DomainRuleError("settings undo state is missing");
        const current = versions.current("settings", userId);
        const [restored] = await tx
          .update(userSettings)
          .set({
            timezone: state.timezone,
            digestTimezone: state.digestTimezone,
            quietHoursTimezone: state.quietHoursTimezone,
            pinnedLanguage: state.pinnedLanguage,
            quietHoursEnabled: state.quietHoursEnabled,
            weekdayQuietStart: state.weekdayQuietStart,
            weekdayQuietEnd: state.weekdayQuietEnd,
            weekendQuietStart: state.weekendQuietStart,
            weekendQuietEnd: state.weekendQuietEnd,
            notificationsSnoozedUntil: parseJsonDate(state.notificationsSnoozedUntil),
            morningReferenceTime: state.morningReferenceTime,
            eveningReferenceTime: state.eveningReferenceTime,
            morningDigestEnabled: state.morningDigestEnabled,
            weeklyReviewEnabled: state.weeklyReviewEnabled,
            weeklyReviewWeekday: state.weeklyReviewWeekday,
            weeklyReviewTime: state.weeklyReviewTime,
            eventReminderOffsetsMinutes: state.eventReminderOffsetsMinutes,
            plannedTaskReminderOffsetMinutes: state.plannedTaskReminderOffsetMinutes,
            criticalPostDueMinutes: state.criticalPostDueMinutes,
            version: sql`${userSettings.version} + 1`,
            updatedAt: input.now,
          })
          .where(and(eq(userSettings.userId, userId), eq(userSettings.version, current)))
          .returning({ userId: userSettings.userId });
        if (!restored) throw new DomainRuleError("undo target settings changed after action");
      }

      const [group] = await tx
        .update(actionGroups)
        .set({ status: "undone", undoneAt: input.now })
        .where(and(eq(actionGroups.workspaceId, input.workspaceId), eq(actionGroups.id, input.groupId), eq(actionGroups.status, "undoing")))
        .returning({ id: actionGroups.id });
      if (!group) throw new DomainRuleError("undo group is not in progress");
      return { reminderRebuildOccurrenceIds: [...rebuild], fuzzyRebuildTaskIds: [...fuzzyRebuild], reconcileTaskIds: [...reconcile] };
    });
  }
}

/** Marks a claimed (`applying`) group applied and drops its pending payloads; the only place that does. */
export async function finalizeGroup(tx: DbTransaction, workspaceId: string, groupId: string, undoExpiresAt: Date, now = new Date()): Promise<void> {
  await tx.delete(pendingActions).where(and(eq(pendingActions.workspaceId, workspaceId), eq(pendingActions.groupId, groupId)));
  const [updated] = await tx
    .update(actionGroups)
    .set({ status: "applied", appliedAt: now, undoExpiresAt })
    .where(and(eq(actionGroups.workspaceId, workspaceId), eq(actionGroups.id, groupId), eq(actionGroups.status, "applying")))
    .returning({ id: actionGroups.id });
  if (!updated) throw new DomainRuleError("action group is not claimable as applied");
}

/**
 * Row versions across the steps of one group: `initial` is what the row was when the group locked
 * it (what the resolver may expect), `current` is what the previous steps left behind.
 */
class VersionTracker {
  private readonly rows = new Map<string, { initial: number; current: number }>();

  register(entity: TouchedVersion["entity"], id: string, version: number): void {
    this.rows.set(`${entity}:${id}`, { initial: version, current: version });
  }

  created(entity: TouchedVersion["entity"], id: string, version: number): void {
    this.register(entity, id, version);
  }

  expect(entity: TouchedVersion["entity"], id: string, expected: number): number {
    const row = this.rows.get(`${entity}:${id}`);
    if (!row) throw new DomainRuleError(`${entity} target is missing`);
    if (row.initial !== expected) throw new DomainRuleError(`${entity} is stale or missing`);
    return row.current;
  }

  current(entity: TouchedVersion["entity"], id: string): number {
    const row = this.rows.get(`${entity}:${id}`);
    if (!row) throw new DomainRuleError(`${entity} target is missing`);
    return row.current;
  }

  bump(touched: readonly TouchedVersion[]): void {
    for (const item of touched) {
      const row = this.rows.get(`${item.entity}:${item.id}`);
      if (row) row.current = item.version;
      else this.rows.set(`${item.entity}:${item.id}`, { initial: item.version, current: item.version });
    }
  }
}

/** Locks every row the steps address, sorted by id per table, and records the versions found. */
async function lockTargets(tx: DbTransaction, workspaceId: string, actorUserId: string, steps: readonly ActionGroupStep[]): Promise<VersionTracker> {
  const taskIds = new Set<string>();
  const occurrenceIds = new Set<string>();
  const goalIds = new Set<string>();
  const memoryIds = new Set<string>();
  let settings = false;
  // Rows this group creates do not exist yet; later steps address them through the tracker instead.
  const createdTaskIds = new Set(
    steps.flatMap((step) => (step.kind === "create_task" ? [step.plan.task.id] : step.kind === "goal_plan" ? step.plans.map((plan) => plan.task.id) : [])),
  );
  for (const step of steps) {
    switch (step.kind) {
      case "create_task":
        if (step.goalLink) goalIds.add(step.goalLink.goalId);
        break;
      case "update_task":
      case "complete_task":
      case "cancel_task":
      case "concretise_task":
      case "change_series":
        taskIds.add(step.taskId);
        break;
      case "update_occurrence":
      case "complete_occurrence":
      case "reschedule_occurrence":
      case "change_reminder":
        occurrenceIds.add(step.occurrenceId);
        break;
      case "update_goal":
        goalIds.add(step.goalId);
        break;
      case "link_task_to_goal":
      case "unlink_task_to_goal":
        taskIds.add(step.taskId);
        goalIds.add(step.goalId);
        break;
      case "update_memory":
      case "delete_memory":
        memoryIds.add(step.memoryId);
        break;
      case "update_settings":
        settings = true;
        break;
      default:
        break;
    }
  }
  for (const id of createdTaskIds) taskIds.delete(id);
  const versions = new VersionTracker();
  const sorted = (set: Set<string>) => [...set].sort();
  // The task behind an addressed occurrence is locked in the task pass, not by the join below:
  // two groups that name a task of one series and an occurrence of another would otherwise take
  // the same two task rows in opposite orders and deadlock. An occurrence never changes its task,
  // so reading the pair without a lock here is safe.
  if (occurrenceIds.size) {
    const owners = await tx
      .select({ taskId: taskOccurrences.taskId })
      .from(taskOccurrences)
      .where(and(eq(taskOccurrences.workspaceId, workspaceId), inArray(taskOccurrences.id, sorted(occurrenceIds))));
    for (const owner of owners) if (!createdTaskIds.has(owner.taskId)) taskIds.add(owner.taskId);
  }
  if (taskIds.size) {
    const ids = sorted(taskIds);
    const rows = await tx
      .select({ id: tasks.id, version: tasks.version })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, ids)))
      .orderBy(tasks.id)
      .for("update");
    if (rows.length !== ids.length) throw new DomainRuleError("task target is missing");
    for (const row of rows) versions.register("task", row.id, row.version);
  }
  if (occurrenceIds.size) {
    const ids = sorted(occurrenceIds);
    const rows = await tx
      .select({ id: taskOccurrences.id, version: taskOccurrences.version })
      .from(taskOccurrences)
      .where(and(eq(taskOccurrences.workspaceId, workspaceId), inArray(taskOccurrences.id, ids)))
      .orderBy(taskOccurrences.id)
      .for("update");
    if (rows.length !== ids.length) throw new DomainRuleError("occurrence target is missing");
    for (const row of rows) versions.register("occurrence", row.id, row.version);
  }
  if (goalIds.size) {
    const ids = sorted(goalIds);
    const rows = await tx
      .select({ id: goals.id, version: goals.version })
      .from(goals)
      .where(and(eq(goals.workspaceId, workspaceId), inArray(goals.id, ids)))
      .orderBy(goals.id)
      .for("update");
    if (rows.length !== ids.length) throw new DomainRuleError("goal target is missing");
    for (const row of rows) versions.register("goal", row.id, row.version);
  }
  if (memoryIds.size) {
    const ids = sorted(memoryIds);
    const rows = await tx
      .select({ id: memoryItems.id, version: memoryItems.version })
      .from(memoryItems)
      .where(and(eq(memoryItems.workspaceId, workspaceId), eq(memoryItems.userId, actorUserId), inArray(memoryItems.id, ids)))
      .orderBy(memoryItems.id)
      .for("update");
    if (rows.length !== ids.length) throw new DomainRuleError("memory target is missing");
    for (const row of rows) versions.register("memory", row.id, row.version);
  }
  if (settings) {
    const [row] = await tx.select({ id: userSettings.userId, version: userSettings.version }).from(userSettings).where(eq(userSettings.userId, actorUserId)).for("update");
    if (!row) throw new DomainRuleError("settings target is missing");
    versions.register("settings", row.id, row.version);
  }
  return versions;
}

function groupPairs(events: readonly UndoEvent[]): Map<string, UndoEvent[]> {
  const map = new Map<string, UndoEvent[]>();
  for (const event of events) {
    const state = (event.actionType === "unlink_task_to_goal" ? event.beforeState : event.afterState) as { taskId?: string; goalId?: string } | null;
    if (!state?.taskId || !state.goalId) throw new DomainRuleError("task-goal undo state is incomplete");
    const key = `${state.taskId}:${state.goalId}`;
    const list = map.get(key) ?? [];
    list.push(event);
    map.set(key, list);
  }
  return map;
}
