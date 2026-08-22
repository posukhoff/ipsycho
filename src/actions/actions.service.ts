import { randomUUID } from "node:crypto";
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { ProposedActionSchema } from "../ai/ai-contracts.js";
import { ACTION_CONFIRMATION_TTL_MS, ACTION_UNDO_TTL_MS, actionExpiry } from "../core/action-lifecycle.js";
import { habitOfferEligible } from "../core/habit-policy.js";
import { validateOneTimeTaskTiming } from "../core/task-policy.js";
import type { OccurrenceScheduleView } from "../core/time-presentation.js";
import {
  splitActionsByDisposition,
  validateActionBatchShape,
  type ProposedActionDraft,
} from "../core/ai-actions.js";
import { rescheduledDefinition } from "../core/reschedule.js";
import { parseLocalDate } from "../core/timezone.js";
import { ContextActionsRepository } from "../context/context-actions.repository.js";
import { ContextService } from "../context/context.service.js";
import { taskDefinitionFromRow } from "../tasks/task-record-mappers.js";
import { TasksService } from "../tasks/tasks.service.js";
import { ReminderSchedulingService } from "../reminders/reminder-scheduling.service.js";
import {
  createTaskInputFromAction,
  InvalidAiActionError,
  reminderRuleFromAction,
  rescheduleFieldsFromAction,
  seriesDefinitionFromAction,
  validateUpdateTaskAction,
} from "./action-conversion.js";
import { ActionMutationsRepository } from "./action-mutations.repository.js";
import { ActionsRepository } from "./actions.repository.js";
import { safeError } from "../observability/safe-error.js";

export interface ActionScope {
  workspaceId: string;
  actorUserId: string;
  recipientUserId: string;
  sourceMessageId?: string;
  now?: Date;
}

export interface ProposedActionsResult {
  applied?: {
    groupId: string;
    count: number;
    titles: string[];
    scheduledReminderAt?: Date;
    occurrenceSchedule?: OccurrenceScheduleView;
    linkedGoalTitles?: string[];
  };
  pending?: { groupId: string; count: number; titles: string[] };
  warnings?: string[];
}

export class ActionStateUncertainError extends Error {
  constructor(readonly groupId: string) {
    super("action state could not be finalized safely");
    this.name = "ActionStateUncertainError";
  }
}

@Injectable()
export class ActionsService implements OnApplicationBootstrap {
  constructor(
    private readonly repository: ActionsRepository,
    private readonly mutations: ActionMutationsRepository,
    private readonly tasks: TasksService,
    private readonly reminders: ReminderSchedulingService,
    private readonly context: ContextService,
    private readonly contextActions: ContextActionsRepository,
  ) {}

  async validate(actions: readonly ProposedActionDraft[], scope: Omit<ActionScope, "sourceMessageId">): Promise<string[]> {
    const now = scope.now ?? new Date();
    const errors: string[] = [];
    const batchError = validateActionBatchShape(actions);
    if (batchError) errors.push(batchError);

    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      if (!action) continue;
      try {
        if (action.type === "create_task") {
          createTaskInputFromAction(action, { ...scope, now });
          if (action.goalLink) {
            const goal = await this.context.findGoal(scope.workspaceId, action.goalLink.goalId);
            if (!goal || goal.status !== "active" || goal.version !== action.goalLink.expectedGoalVersion) throw new Error("linked goal is missing or stale");
          }
          continue;
        }
        if (action.type === "update_task") {
          validateUpdateTaskAction(action);
          const task = await this.tasks.getTask(scope.workspaceId, action.taskId);
          if (!task || task.version !== action.expectedVersion) throw new Error("target task is missing or stale");
          if (action.patch.habitMode === true) {
            if (!task.recurrenceRule) throw new Error("habit mode requires a recurring task");
            if (task.habitMode) throw new Error("task is already a habit");
            if (action.source === "ai_inferred" && !habitOfferEligible({
              recurring: Boolean(task.recurrenceRule),
              kind: task.kind,
              alreadyHabit: task.habitMode,
              offeredBefore: Boolean(task.habitOfferSentAt),
              behavioral: true, // semantic suitability is decided by the model; this gate enforces product frequency/type rules.
            })) throw new Error("habit mode is not eligible or was already offered for this task");
          }
          continue;
        }
        if (action.type === "create_goal") {
          if (!action.title.trim()) throw new Error("goal title is required");
          if (action.targetLocalDate) parseLocalDate(action.targetLocalDate);
          continue;
        }
        if (action.type === "create_goal_plan") {
          if (!action.goal.title.trim()) throw new Error("goal title is required");
          if (action.goal.targetLocalDate) parseLocalDate(action.goal.targetLocalDate);
          if (!action.tasks.length) throw new Error("goal plan requires at least one task");
          for (const task of action.tasks) createTaskInputFromAction({ ...task, type: "create_task", source: action.source, confidence: action.confidence, goalLink: null }, { ...scope, now });
          continue;
        }
        if (action.type === "update_goal") {
          const goal = await this.context.findGoal(scope.workspaceId, action.goalId);
          if (!goal || goal.version !== action.expectedVersion) throw new Error("goal is missing or stale");
          const patch = action.patch;
          if (patch.title === null && patch.why === null && patch.targetLocalDate === null && patch.status === null && patch.reviewEnabled === null) {
            throw new Error("update_goal patch must change at least one field");
          }
          if (patch.title !== null && !patch.title.trim()) throw new Error("goal title cannot be blank");
          if (patch.why !== null && !patch.why.trim()) throw new Error("goal why cannot be blank");
          if (patch.targetLocalDate) parseLocalDate(patch.targetLocalDate);
          continue;
        }
        if (action.type === "save_memory") {
          if (!action.content.trim()) throw new Error("memory content is required");
          continue;
        }
        if (action.type === "delete_memory") {
          const memory = await this.context.findMemory(scope.workspaceId, scope.actorUserId, action.memoryId);
          if (!memory || memory.version !== action.expectedVersion) throw new Error("memory is missing or stale");
          continue;
        }
        if (action.type === "update_memory") {
          const memory = await this.context.findMemory(scope.workspaceId, scope.actorUserId, action.memoryId);
          if (!memory || memory.version !== action.expectedVersion) throw new Error("memory is missing or stale");
          if (action.patch.content === null && action.patch.sensitive === null) throw new Error("update_memory patch must change at least one field");
          if (action.patch.content !== null && !action.patch.content.trim()) throw new Error("memory content cannot be blank");
          continue;
        }
        if (action.type === "link_task_to_goal") {
          const [task, goal] = await Promise.all([
            this.tasks.getTask(scope.workspaceId, action.taskId),
            this.context.findGoal(scope.workspaceId, action.goalId),
          ]);
          if (!task || task.version !== action.expectedTaskVersion) throw new Error("target task is missing or stale");
          if (!goal || goal.version !== action.expectedGoalVersion || goal.status !== "active") throw new Error("target goal is missing or stale");
          if (await this.context.findTaskGoalLink(scope.workspaceId, action.taskId, action.goalId)) throw new Error("task is already linked to this goal");
          continue;
        }
        if (action.type === "change_series") {
          const task = await this.tasks.getTask(scope.workspaceId, action.taskId);
          if (!task || task.version !== action.expectedVersion) throw new Error("series task is missing or stale");
          if (action.operation === "resume") {
            if (action.edit !== null) throw new Error("edit payload is only valid for series edit");
            if (task.status !== "paused" || !task.recurrenceRule) throw new Error("only a paused recurring series can resume");
          } else {
            if (!task.recurrenceRule) throw new Error("task is not a recurring series");
            if (action.operation === "edit") seriesDefinitionFromAction(action, taskDefinitionFromRow(task));
            else if (action.edit !== null) throw new Error("edit payload is only valid for series edit");
          }
          continue;
        }
        if (action.type === "change_reminder") {
          const occurrenceContext = await this.tasks.getOccurrenceContext(scope.workspaceId, action.occurrenceId);
          if (!occurrenceContext || occurrenceContext.occurrence.version !== action.expectedVersion) throw new Error("target occurrence is missing or stale");
          const rule = reminderRuleFromAction(action);
          if (rule?.exactAt && rule.exactAt <= now) throw new Error("reminder must be in the future");
          await this.reminders.validateExplicitReminderChange({
            workspaceId: scope.workspaceId, userId: scope.recipientUserId, occurrenceId: action.occurrenceId, mode: action.mode,
            ...(rule ? { rule } : {}), now,
          });
          continue;
        }
        const occurrenceContext = await this.tasks.getOccurrenceContext(scope.workspaceId, action.occurrenceId);
        if (!occurrenceContext || occurrenceContext.occurrence.version !== action.expectedVersion) throw new Error("target occurrence is missing or stale");
        if (action.type === "complete_occurrence") continue;

        const schedule = rescheduleFieldsFromAction(action);
        if (action.schedule.timezone !== occurrenceContext.occurrence.timezone) throw new Error("reschedule timezone does not match target occurrence");
        if ((schedule.fuzzyHorizonText || schedule.reviewAt) && occurrenceContext.task.recurrenceRule) {
          throw new Error("a recurring occurrence cannot be rescheduled to fuzzy time; change the series instead");
        }
        const nextDefinition = rescheduledDefinition(taskDefinitionFromRow(occurrenceContext.task), schedule);
        const timingErrors = validateOneTimeTaskTiming(nextDefinition, now, "rescheduling a one-time task");
        if (timingErrors.length) throw new Error(timingErrors.join("; "));
        if (await this.tasks.isRescheduleReasonRequired(scope.workspaceId, action.occurrenceId) && !action.reason?.trim()) {
          throw new Error("reschedule reason is required");
        }
      } catch (error) {
        errors.push(`action ${index + 1}: ${error instanceof Error ? error.message : "invalid action"}`);
      }
    }
    return errors;
  }

  async handleProposed(actions: readonly ProposedActionDraft[], scope: ActionScope): Promise<ProposedActionsResult> {
    const batchError = validateActionBatchShape(actions);
    if (batchError) throw new InvalidAiActionError(batchError);
    const { immediate, pending } = splitActionsByDisposition(actions);
    const result: ProposedActionsResult = {};
    const warnings: string[] = [];
    let newCriticalCount = actions.filter((action) => action.type === "create_task" && action.definition.importance === "critical").length;
    for (const action of actions) {
      if (action.type !== "update_task" || action.patch.importance !== "critical") continue;
      const existing = await this.tasks.getTask(scope.workspaceId, action.taskId);
      if (existing && existing.importance !== "critical") newCriticalCount += 1;
    }
    if (newCriticalCount > 0 && (await this.tasks.countActiveCritical(scope.workspaceId)) + newCriticalCount > 3) {
      warnings.push("Активных критических задач станет больше трёх. Это может заметно увеличить давление напоминаний.");
    }

    if (pending.length) result.pending = await this.storePending(pending, scope);
    try {
      if (immediate.length) result.applied = await this.applyActions(immediate, scope);
      if (warnings.length) result.warnings = warnings;
      return result;
    } catch (error) {
      if (result.pending) {
        await this.repository.cancelPendingGroup(scope.workspaceId, scope.actorUserId, result.pending.groupId).catch(() => undefined);
      }
      throw error;
    }
  }

  async confirm(workspaceId: string, actorUserId: string, recipientUserId: string, groupId: string, now = new Date()) {
    const claimed = await this.repository.claimPendingGroup(workspaceId, actorUserId, groupId, now);
    if (!claimed) throw new Error("confirmation expired or already handled");

    let actions: ProposedActionDraft[];
    try {
      actions = claimed.actions.map((row) => ProposedActionSchema.parse(row.payload));
      const batchError = validateActionBatchShape(actions);
      if (batchError) throw new InvalidAiActionError(batchError);
    } catch (error) {
      await this.repository.markFailed(workspaceId, groupId).catch(() => undefined);
      throw error;
    }

    try {
      if (actions.every((action) => action.type === "create_task")) {
        const createActions = actions as Array<Extract<ProposedActionDraft, { type: "create_task" }>>;
        const created = await this.tasks.createTasks(createActions.map((action) => createTaskInputFromAction(action, {
          workspaceId,
          actorUserId,
          recipientUserId,
          sourceActionGroupId: groupId,
          now,
        }))); 
        const linkedGoalTitles = await this.linkCreatedTaskGoals(workspaceId, groupId, createActions, created, now);
        await this.finalizeCreatedTasks(workspaceId, groupId, createActions, created, now);
        const scheduledReminderAt = created[0]?.reminderSchedules.find((item) => item.purpose === "user_reminder")?.scheduledFor;
        const occurrenceSchedule = created[0]?.occurrenceSchedule;
        return {
          groupId, count: created.length, titles: createActions.map((action) => action.title),
          ...(scheduledReminderAt ? { scheduledReminderAt } : {}),
          ...(occurrenceSchedule ? { occurrenceSchedule } : {}),
          ...(linkedGoalTitles.length ? { linkedGoalTitles } : {}),
        };
      }
      if (actions.every((action) => action.type === "save_memory")) {
        return this.applySaveMemories(actions as Array<Extract<ProposedActionDraft, { type: "save_memory" }>>, {
          workspaceId, actorUserId, recipientUserId, now,
          ...(claimed.group.sourceMessageId ? { sourceMessageId: claimed.group.sourceMessageId } : {}),
        }, groupId);
      }
      const action = actions[0];
      if (!action) throw new Error("empty action group");
      if (action.type === "create_goal_plan") return this.applyGoalPlan(action, { workspaceId, actorUserId, recipientUserId, now, ...(claimed.group.sourceMessageId ? { sourceMessageId: claimed.group.sourceMessageId } : {}) }, groupId);
      if (action.type === "create_task") throw new Error("mixed create/mutation action group is not supported");
      return await this.applyClaimedMutation(action, {
        workspaceId, actorUserId, recipientUserId, now,
        ...(claimed.group.sourceMessageId ? { sourceMessageId: claimed.group.sourceMessageId } : {}),
      }, groupId);
    } catch (error) {
      await this.repository.markFailed(workspaceId, groupId).catch(() => undefined);
      throw error;
    }
  }

  async cancel(workspaceId: string, actorUserId: string, groupId: string): Promise<boolean> {
    return this.repository.cancelPendingGroup(workspaceId, actorUserId, groupId);
  }

  async undo(workspaceId: string, actorUserId: string, groupId: string, now = new Date()): Promise<void> {
    const claimed = await this.repository.claimUndo(workspaceId, actorUserId, groupId, now);
    if (!claimed) throw new Error("undo expired or action already changed");
    if (claimed.events.length && claimed.events.every((event) => event.actionType === "create_goal_plan")) {
      const goal = claimed.events.find((event) => event.entityType === "goal");
      const taskTargets = claimed.events.filter((event) => event.entityType === "task" && event.postVersion !== null).map((event) => ({ id: event.entityId, version: event.postVersion! }));
      if (!goal || goal.postVersion === null) throw new Error("goal plan undo state is incomplete");
      await this.tasks.undoCreatedTasks(workspaceId, taskTargets);
      await this.contextActions.undoGoalPlan(workspaceId, groupId, goal.entityId, now);
      return;
    }

    const createOnly = claimed.events.every((event) => event.actionType === "create_task" && event.entityType === "task" && event.postVersion !== null);
    if (createOnly) {
      const createdTasks = claimed.events.map((event) => ({ id: event.entityId, version: event.postVersion! }));
      try {
        await this.tasks.undoCreatedTasks(workspaceId, createdTasks);
      } catch (error) {
        await this.repository.releaseUndoClaim(workspaceId, groupId).catch(() => undefined);
        throw error;
      }
      try {
        await this.repository.finalizeUndo(workspaceId, groupId);
      } catch {
        try {
          await this.repository.finalizeUndo(workspaceId, groupId);
        } catch {
          throw new ActionStateUncertainError(groupId);
        }
      }
      return;
    }

    const contextOnly = claimed.events.length > 0 && claimed.events.every((event) => ["goal", "memory", "task_goal"].includes(event.entityType));
    if (contextOnly) {
      try {
        await this.contextActions.undoContextGroup({ workspaceId, groupId, events: claimed.events, now });
        return;
      } catch (error) {
        await this.repository.releaseUndoClaim(workspaceId, groupId).catch(() => undefined);
        throw error;
      }
    }

    try {
      const result = await this.mutations.undoMutationGroup({
        workspaceId,
        groupId,
        events: claimed.events,
        now,
      });
      for (const occurrenceId of result.reminderRebuildOccurrenceIds) {
        await this.reminders.rebuildOccurrence(workspaceId, occurrenceId).catch((error) => {
          console.error("reminder rebuild deferred after undo", { occurrenceId, error: safeError(error) });
        });
      }
      for (const taskId of result.recurrenceReconcileTaskIds) {
        await this.tasks.reconcileRecurringTask(workspaceId, taskId, now).catch((error) => {
          console.error("series reconciliation deferred after undo", { taskId, error: safeError(error) });
        });
      }
      const taskReminderRebuildIds = new Set(claimed.events
        .filter((event) => event.entityType === "task" && event.actionType === "reschedule_occurrence")
        .map((event) => event.entityId));
      for (const taskId of taskReminderRebuildIds) {
        await this.reminders.rebuildFuzzyTask(workspaceId, actorUserId, taskId, now).catch((error) => {
          console.error("task-level planning reminder rebuild deferred after undo", { taskId, error: safeError(error) });
        });
      }
    } catch (error) {
      await this.repository.releaseUndoClaim(workspaceId, groupId).catch(() => undefined);
      throw error;
    }
  }

  async cleanupExpiredConfirmations(now = new Date()): Promise<number> {
    return this.repository.expirePendingGroups(now);
  }

  async cleanupExpiredAuditPayloads(now = new Date()): Promise<number> {
    return this.repository.scrubExpiredActionPayloads(now);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverInterruptedActions();
  }

  async recoverInterruptedActions(now = new Date()): Promise<void> {
    const groups = await this.repository.listRecoveryGroups();
    for (const group of groups) {
      const createdTasks = await this.tasks.getCreatedTasksForActionGroup(group.workspaceId, group.id);
      const events = await this.repository.listEventsForGroup(group.workspaceId, group.id);
      try {
        if (group.status === "applying") {
          if (!createdTasks.length) {
            // Mutation actions finalize state + audit in one transaction. If an applying
            // mutation survives a restart, the mutation itself did not commit.
            await this.repository.markFailed(group.workspaceId, group.id);
            continue;
          }
          await this.repository.finalizeApplied({
            workspaceId: group.workspaceId,
            groupId: group.id,
            undoExpiresAt: actionExpiry(group.createdAt, ACTION_UNDO_TTL_MS),
            events: createdTasks.map((task) => ({
              actionType: "create_task",
              entityType: "task",
              entityId: task.id,
              postVersion: task.version,
              afterState: { title: task.title },
            })),
          });
          continue;
        }

        if (events.some((event) => event.actionType !== "create_task")) {
          // Mutation undo is transactional with group finalization. A surviving `undoing`
          // state means the restore transaction never committed, so make it retryable.
          await this.repository.releaseUndoClaim(group.workspaceId, group.id);
          continue;
        }
        if (createdTasks.length === 0) await this.repository.finalizeUndo(group.workspaceId, group.id);
        else await this.repository.releaseUndoClaim(group.workspaceId, group.id);
      } catch (error) {
        console.error("action recovery failed", {
          groupId: group.id,
          status: group.status,
          error: safeError(error),
        });
      }
    }
    await this.repository.expirePendingGroups(now).catch((error) => console.error("pending action cleanup failed", safeError(error)));
  }

  private async applyActions(actions: ProposedActionDraft[], scope: ActionScope) {
    const now = scope.now ?? new Date();
    const groupId = randomUUID();
    await this.repository.createImmediateGroup({
      id: groupId,
      workspaceId: scope.workspaceId,
      actorUserId: scope.actorUserId,
      ...(scope.sourceMessageId ? { sourceMessageId: scope.sourceMessageId } : {}),
    });

    if (actions.every((action) => action.type === "create_task")) {
      const createActions = actions as Array<Extract<ProposedActionDraft, { type: "create_task" }>>;
      let created: Awaited<ReturnType<TasksService["createTasks"]>>;
      try {
        created = await this.tasks.createTasks(createActions.map((action) => createTaskInputFromAction(action, {
          workspaceId: scope.workspaceId,
          actorUserId: scope.actorUserId,
          recipientUserId: scope.recipientUserId,
          sourceActionGroupId: groupId,
          now,
        })));
      } catch (error) {
        await this.repository.markFailed(scope.workspaceId, groupId).catch(() => undefined);
        throw error;
      }
      const linkedGoalTitles = await this.linkCreatedTaskGoals(scope.workspaceId, groupId, createActions, created, now);
      await this.finalizeCreatedTasks(scope.workspaceId, groupId, createActions, created, now);
      const scheduledReminderAt = created[0]?.reminderSchedules.find((item) => item.purpose === "user_reminder")?.scheduledFor;
      const occurrenceSchedule = created[0]?.occurrenceSchedule;
      return {
        groupId, count: created.length, titles: createActions.map((action) => action.title),
        ...(scheduledReminderAt ? { scheduledReminderAt } : {}),
        ...(occurrenceSchedule ? { occurrenceSchedule } : {}),
        ...(linkedGoalTitles.length ? { linkedGoalTitles } : {}),
      };
    }

    if (actions.every((action) => action.type === "save_memory")) {
      return this.applySaveMemories(actions as Array<Extract<ProposedActionDraft, { type: "save_memory" }>>, { ...scope, now }, groupId);
    }

    if (actions.length === 1 && actions[0]?.type === "create_goal_plan") {
      return this.applyGoalPlan(actions[0], { ...scope, now }, groupId);
    }

    const action = actions[0];
    if (!action) throw new Error("empty action group");
    if (action.type === "create_goal_plan") return this.applyGoalPlan(action, { ...scope, now }, groupId);
    if (action.type === "create_task") throw new Error("mixed create/mutation action group is not supported");
    try {
      return await this.applyClaimedMutation(action, { ...scope, now }, groupId);
    } catch (error) {
      await this.repository.markFailed(scope.workspaceId, groupId).catch(() => undefined);
      throw error;
    }
  }

  private async applySaveMemories(
    actions: Array<Extract<ProposedActionDraft, { type: "save_memory" }>>,
    scope: ActionScope & { now: Date },
    groupId: string,
  ) {
    return this.contextActions.applySaveMemories({
      workspaceId: scope.workspaceId,
      groupId,
      actorUserId: scope.actorUserId,
      memories: actions.map((action) => ({
        memoryType: action.memoryType,
        content: action.content.trim(),
        sensitive: action.sensitive,
        source: action.source,
      })),
      ...(scope.sourceMessageId ? { sourceMessageId: scope.sourceMessageId } : {}),
      undoExpiresAt: actionExpiry(scope.now, ACTION_UNDO_TTL_MS),
    });
  }

  private async applyClaimedMutation(
    action: Exclude<ProposedActionDraft, { type: "create_task" | "create_goal_plan" }>,
    scope: ActionScope & { now: Date },
    groupId: string,
  ) {
    const undoExpiresAt = actionExpiry(scope.now, ACTION_UNDO_TTL_MS);
    if (action.type === "update_task") {
      validateUpdateTaskAction(action);
      const result = await this.mutations.applyUpdateTask({
        workspaceId: scope.workspaceId,
        groupId,
        actorUserId: scope.actorUserId,
        taskId: action.taskId,
        expectedVersion: action.expectedVersion,
        patch: {
          ...(action.patch.title !== null ? { title: action.patch.title.trim() } : {}),
          ...(action.patch.why !== null ? { why: action.patch.why.trim() } : {}),
          ...(action.patch.nextAction !== null ? { nextAction: action.patch.nextAction.trim() } : {}),
          ...(action.patch.context !== null ? { context: action.patch.context.trim() } : {}),
          ...(action.patch.importance !== null ? { importance: action.patch.importance } : {}),
          ...(action.patch.checklist !== null ? { checklist: action.patch.checklist.map((item) => ({ text: item.text.trim(), done: item.done })) } : {}),
          ...(action.patch.habitMode !== null ? { habitMode: action.patch.habitMode } : {}),
          ...(action.patch.minimumAction !== null ? { minimumAction: action.patch.minimumAction.trim() } : {}),
          ...(action.patch.desiredAction !== null ? { desiredAction: action.patch.desiredAction.trim() } : {}),
          ...(action.patch.habitTrigger !== null ? { habitTrigger: action.patch.habitTrigger.trim() } : {}),
        },
        undoExpiresAt,
      });
      return result;
    }
    if (action.type === "create_goal") {
      if (action.targetLocalDate) parseLocalDate(action.targetLocalDate);
      return this.contextActions.applyCreateGoal({
        workspaceId: scope.workspaceId, groupId, actorUserId: scope.actorUserId,
        title: action.title.trim(),
        ...(action.why?.trim() ? { why: action.why.trim() } : {}),
        ...(action.targetLocalDate ? { targetLocalDate: action.targetLocalDate } : {}),
        undoExpiresAt,
      });
    }
    if (action.type === "update_goal") {
      if (action.patch.targetLocalDate) parseLocalDate(action.patch.targetLocalDate);
      return this.contextActions.applyUpdateGoal({
        workspaceId: scope.workspaceId, groupId, actorUserId: scope.actorUserId, goalId: action.goalId, expectedVersion: action.expectedVersion,
        patch: {
          ...(action.patch.title !== null ? { title: action.patch.title.trim() } : {}),
          ...(action.patch.why !== null ? { why: action.patch.why.trim() } : {}),
          ...(action.patch.targetLocalDate !== null ? { targetLocalDate: action.patch.targetLocalDate } : {}),
          ...(action.patch.status !== null ? { status: action.patch.status } : {}),
          ...(action.patch.reviewEnabled !== null ? { reviewEnabled: action.patch.reviewEnabled } : {}),
        },
        now: scope.now, undoExpiresAt,
      });
    }
    if (action.type === "save_memory") {
      return this.contextActions.applySaveMemory({
        workspaceId: scope.workspaceId, groupId, actorUserId: scope.actorUserId,
        memoryType: action.memoryType, content: action.content.trim(), sensitive: action.sensitive, source: action.source,
        ...(scope.sourceMessageId ? { sourceMessageId: scope.sourceMessageId } : {}),
        undoExpiresAt,
      });
    }
    if (action.type === "delete_memory") {
      return this.contextActions.applyDeleteMemory({
        workspaceId: scope.workspaceId, groupId, actorUserId: scope.actorUserId,
        memoryId: action.memoryId, expectedVersion: action.expectedVersion, undoExpiresAt,
      });
    }
    if (action.type === "update_memory") {
      return this.contextActions.applyUpdateMemory({
        workspaceId: scope.workspaceId, groupId, actorUserId: scope.actorUserId,
        memoryId: action.memoryId, expectedVersion: action.expectedVersion,
        patch: {
          ...(action.patch.content !== null ? { content: action.patch.content.trim() } : {}),
          ...(action.patch.sensitive !== null ? { sensitive: action.patch.sensitive } : {}),
        },
        now: scope.now, undoExpiresAt,
      });
    }
    if (action.type === "link_task_to_goal") {
      return this.contextActions.applyLinkTaskToGoal({
        workspaceId: scope.workspaceId, groupId, taskId: action.taskId, expectedTaskVersion: action.expectedTaskVersion,
        goalId: action.goalId, expectedGoalVersion: action.expectedGoalVersion, source: action.source, confidence: action.confidence, undoExpiresAt,
      });
    }
    if (action.type === "change_reminder") {
      const rule = reminderRuleFromAction(action);
      const result = await this.mutations.applyChangeReminder({
        workspaceId: scope.workspaceId, groupId, actorUserId: scope.actorUserId, occurrenceId: action.occurrenceId, expectedVersion: action.expectedVersion,
        mode: action.mode, ...(rule ? { rule } : {}), undoExpiresAt,
      });
      if (result.reminderRebuildOccurrenceId) await this.reminders.rebuildOccurrence(scope.workspaceId, result.reminderRebuildOccurrenceId).catch((error) => {
        console.error("reminder rebuild deferred", { occurrenceId: result.reminderRebuildOccurrenceId, error: safeError(error) });
      });
      return result;
    }
    if (action.type === "change_series") {
      const task = action.operation === "edit" ? await this.tasks.getTask(scope.workspaceId, action.taskId) : null;
      if (action.operation === "edit" && !task) throw new Error("series task is missing or stale");
      const editDefinition = action.operation === "edit"
        ? seriesDefinitionFromAction(action, taskDefinitionFromRow(task!))
        : undefined;
      const result = await this.mutations.applyChangeSeries({
        workspaceId: scope.workspaceId, groupId, actorUserId: scope.actorUserId, taskId: action.taskId, expectedVersion: action.expectedVersion,
        operation: action.operation, ...(editDefinition ? { editDefinition } : {}), now: scope.now, undoExpiresAt,
      });
      if (result.recurrenceReconcileTaskId) await this.tasks.reconcileRecurringTask(scope.workspaceId, result.recurrenceReconcileTaskId, scope.now).catch((error) => {
        console.error("series recurrence reconciliation deferred", { taskId: result.recurrenceReconcileTaskId, error: safeError(error) });
      });
      return result;
    }
    if (action.type === "complete_occurrence") {
      return this.mutations.applyCompleteOccurrence({
        workspaceId: scope.workspaceId,
        groupId,
        actorUserId: scope.actorUserId,
        occurrenceId: action.occurrenceId,
        expectedVersion: action.expectedVersion,
        now: scope.now,
        undoExpiresAt,
      });
    }

    const schedule = rescheduleFieldsFromAction(action);
    const result = await this.mutations.applyRescheduleOccurrence({
      workspaceId: scope.workspaceId,
      groupId,
      actorUserId: scope.actorUserId,
      occurrenceId: action.occurrenceId,
      expectedVersion: action.expectedVersion,
      scheduleTimezone: action.schedule.timezone,
      schedule,
      ...(action.reason?.trim() ? { reason: action.reason.trim() } : {}),
      now: scope.now,
      undoExpiresAt,
    });
    if (result.reminderRebuildOccurrenceId) {
      await this.reminders.rebuildOccurrence(scope.workspaceId, result.reminderRebuildOccurrenceId).catch((error) => {
        console.error("reminder rebuild deferred", { occurrenceId: result.reminderRebuildOccurrenceId, error: safeError(error) });
      });
    }
    if (result.reminderRebuildTaskId) {
      await this.reminders.rebuildFuzzyTask(scope.workspaceId, scope.recipientUserId, result.reminderRebuildTaskId, scope.now).catch((error) => {
        console.error("task-level planning reminder rebuild deferred", { taskId: result.reminderRebuildTaskId, error: safeError(error) });
      });
    }
    return result;
  }

  private async applyGoalPlan(action: Extract<ProposedActionDraft, { type: "create_goal_plan" }>, scope: ActionScope & { now: Date }, groupId: string) {
    let goal: Awaited<ReturnType<ContextActionsRepository["createGoalPlanSeed"]>> | undefined;
    let created: Awaited<ReturnType<TasksService["createTasks"]>> = [];
    try {
      goal = await this.contextActions.createGoalPlanSeed({ workspaceId: scope.workspaceId, actorUserId: scope.actorUserId, groupId, title: action.goal.title.trim(), ...(action.goal.why?.trim() ? { why: action.goal.why.trim() } : {}), ...(action.goal.targetLocalDate ? { targetLocalDate: action.goal.targetLocalDate } : {}) });
      const tasks = action.tasks.map((task) => ({ ...task, type: "create_task" as const, source: action.source, confidence: action.confidence, goalLink: null }));
      created = await this.tasks.createTasks(tasks.map((task) => createTaskInputFromAction(task, { workspaceId: scope.workspaceId, actorUserId: scope.actorUserId, recipientUserId: scope.recipientUserId, sourceActionGroupId: groupId, now: scope.now })));
      await this.contextActions.finalizeGoalPlan({ workspaceId: scope.workspaceId, groupId, goal, taskIds: created.map((item) => item.taskId), undoExpiresAt: actionExpiry(scope.now, ACTION_UNDO_TTL_MS) });
      return { groupId, count: created.length + 1, titles: [goal.title, ...action.tasks.map((task) => task.title)], linkedGoalTitles: [goal.title] };
    } catch (error) {
      if (created.length) await this.tasks.undoCreatedTasks(scope.workspaceId, created.map((item) => ({ id: item.taskId, version: 1 }))).catch(() => undefined);
      if (goal) await this.contextActions.discardGoalPlanSeed(scope.workspaceId, goal.id).catch(() => undefined);
      throw error;
    }
  }

  private async storePending(actions: ProposedActionDraft[], scope: ActionScope) {
    const now = scope.now ?? new Date();
    const groupId = randomUUID();
    await this.repository.createPendingGroup({
      id: groupId,
      workspaceId: scope.workspaceId,
      actorUserId: scope.actorUserId,
      ...(scope.sourceMessageId ? { sourceMessageId: scope.sourceMessageId } : {}),
      expiresAt: actionExpiry(now, ACTION_CONFIRMATION_TTL_MS),
      actions: actions.map((action) => ({ id: randomUUID(), actionType: action.type, payload: action })),
    });
    for (const action of actions) {
      if (action.type === "update_task" && action.source === "ai_inferred" && action.patch.habitMode === true) {
        const marked = await this.tasks.markHabitOfferSent(scope.workspaceId, action.taskId, now);
        if (!marked) { await this.repository.cancelPendingGroup(scope.workspaceId, scope.actorUserId, groupId).catch(() => undefined); throw new InvalidAiActionError("habit mode was already offered for this task"); }
      }
    }
    return { groupId, count: actions.length, titles: actions.map(describeAction) };
  }

  private async finalizeCreatedTasks(
    workspaceId: string,
    groupId: string,
    actions: Array<Extract<ProposedActionDraft, { type: "create_task" }>>,
    created: Array<{ taskId: string }>,
    now: Date,
  ): Promise<void> {
    const finalize = () => this.repository.finalizeApplied({
      workspaceId,
      groupId,
      undoExpiresAt: actionExpiry(now, ACTION_UNDO_TTL_MS),
      events: created.map((item, index) => ({
        actionType: "create_task",
        entityType: "task",
        entityId: item.taskId,
        postVersion: 1,
        afterState: { title: actions[index]?.title ?? "" },
      })),
    });

    try {
      await finalize();
      return;
    } catch (finalizeError) {
      const targets = created.map((item) => ({ id: item.taskId, version: 1 }));
      let compensationFailed = false;
      try {
        await this.tasks.undoCreatedTasks(workspaceId, targets);
      } catch {
        compensationFailed = true;
      }

      if (!compensationFailed) {
        await this.repository.markFailed(workspaceId, groupId).catch(() => undefined);
        throw finalizeError;
      }
      try {
        await finalize();
      } catch {
        throw new ActionStateUncertainError(groupId);
      }
    }
  }

  private async linkCreatedTaskGoals(
    workspaceId: string,
    groupId: string,
    actions: Array<Extract<ProposedActionDraft, { type: "create_task" }>>,
    created: Array<{ taskId: string }>,
    _now: Date,
  ): Promise<string[]> {
    const titles: string[] = [];
    for (const [index, action] of actions.entries()) {
      const goalLink = action.goalLink;
      const task = created[index];
      if (!goalLink || !task) continue;
      titles.push(await this.contextActions.linkCreatedTaskToGoal({
        workspaceId, groupId, taskId: task.taskId, expectedTaskVersion: 1,
        goalId: goalLink.goalId, expectedGoalVersion: goalLink.expectedGoalVersion, confidence: goalLink.confidence,
      }));
    }
    return titles;
  }
}

function describeAction(action: ProposedActionDraft): string {
  if (action.type === "create_task") return action.title;
  if (action.type === "update_task") return "Изменить задачу";
  if (action.type === "complete_occurrence") return "Отметить выполнение";
  if (action.type === "reschedule_occurrence") return "Перенести выполнение";
  if (action.type === "create_goal") return action.title;
  if (action.type === "create_goal_plan") return action.goal.title;
  if (action.type === "update_goal") return "Изменить цель";
  if (action.type === "save_memory") return "Сохранить в память";
  if (action.type === "delete_memory") return "Удалить из памяти";
  if (action.type === "update_memory") return "Изменить память";
  if (action.type === "change_reminder") return "Изменить напоминание";
  if (action.type === "change_series") return "Изменить повторяющуюся серию";
  return "Связать задачу с целью";
}


export { InvalidAiActionError };
