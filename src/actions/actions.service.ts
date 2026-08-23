import { randomUUID } from "node:crypto";
import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { ProposedActionSchema } from "../ai/ai-contracts.js";
import { ACTION_CONFIRMATION_TTL_MS, ACTION_UNDO_TTL_MS, actionExpiry } from "../core/action-lifecycle.js";
import { habitOfferEligible } from "../core/habit-policy.js";
import { validateOneTimeTaskTiming } from "../core/task-policy.js";
import { compileTaskBatchShape } from "../core/task-batch.js";
import type { OccurrenceScheduleView } from "../core/time-presentation.js";
import type { StructuredLocalScheduleInput } from "../core/local-schedule.js";
import type { AppliedReportItem } from "../core/applied-report.js";
import {
  splitActionsByDisposition,
  validateActionBatchShape,
  type ProposedActionDraft,
} from "../core/ai-actions.js";
import { rescheduledDefinition } from "../core/reschedule.js";
import { localDateAndTimeToUtc, parseLocalDate } from "../core/timezone.js";
import { normalizeLanguageTag } from "../core/language.js";
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
import { SettingsService } from "../settings/settings.service.js";
import { TaskBatchRepository, type PreparedTaskBatchStep } from "./task-batch.repository.js";

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
    /** False for interaction-only actions such as Seen/blocker that have no reversible state transition. */
    undoable?: boolean;
    count: number;
    titles: string[];
    scheduledReminderAt?: Date;
    occurrenceSchedule?: OccurrenceScheduleView;
    linkedGoalTitles?: string[];
    renamedFrom?: string;
    /** Persisted facts for the user-facing applied report; empty when nothing was applied. */
    items?: AppliedReportItem[];
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
    private readonly settings: SettingsService,
    private readonly taskBatches: TaskBatchRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  isTaskBatchEnabled(): boolean {
    return this.config.taskBatchEnabled;
  }

  async validate(actions: readonly ProposedActionDraft[], scope: Omit<ActionScope, "sourceMessageId">): Promise<string[]> {
    const now = scope.now ?? new Date();
    const errors: string[] = [];
    const batchError = validateActionBatchShape(actions);
    if (batchError) errors.push(batchError);

    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      if (!action) continue;
      try {
        if (action.type === "task_batch") {
          if (!this.config.taskBatchEnabled) throw new Error("task_batch rollout is disabled");
          compileTaskBatchShape(action);
          for (const step of action.steps) {
            if (step.operation === "create") {
              createTaskInputFromAction({ ...step, type: "create_task" }, { ...scope, now });
              if (step.goalLink) {
                const goal = await this.context.findGoal(scope.workspaceId, step.goalLink.goalId);
                if (!goal || goal.status !== "active" || goal.version !== step.goalLink.expectedGoalVersion) throw new Error(`step ${step.stepId}: linked goal is missing or stale`);
              }
              continue;
            }
            if (step.operation === "update") {
              validateUpdateTaskAction({ ...step, type: "update_task", taskId: step.target.kind === "persisted" ? step.target.taskId : scope.actorUserId, expectedVersion: step.target.kind === "persisted" ? step.target.expectedTaskVersion : 1 });
              if (step.target.kind === "persisted") {
                const task = await this.tasks.getTask(scope.workspaceId, step.target.taskId);
                if (!task || task.version !== step.target.expectedTaskVersion) throw new Error(`step ${step.stepId}: target task is missing or stale`);
              }
              continue;
            }
            if (step.operation === "link_goal") {
              const goal = await this.context.findGoal(scope.workspaceId, step.goalId);
              if (!goal || goal.version !== step.expectedGoalVersion || goal.status !== "active") throw new Error(`step ${step.stepId}: target goal is missing or stale`);
              if (step.target.kind === "persisted") {
                const task = await this.tasks.getTask(scope.workspaceId, step.target.taskId);
                if (!task || task.version !== step.target.expectedTaskVersion) throw new Error(`step ${step.stepId}: target task is missing or stale`);
                if (await this.context.findTaskGoalLink(scope.workspaceId, step.target.taskId, step.goalId)) throw new Error(`step ${step.stepId}: task is already linked to this goal`);
              }
              continue;
            }
            const stepErrors = await this.validate([{ ...step, type: "reschedule_occurrence" }], scope);
            if (stepErrors.length) throw new Error(`step ${step.stepId}: ${stepErrors.join("; ")}`);
          }
          continue;
        }
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
        if (action.type === "update_settings") {
          await this.validateSettingsAction(action, scope.actorUserId, now);
          continue;
        }
        if (action.type === "update_occurrence") {
          const occurrenceContext = await this.tasks.getOccurrenceContext(scope.workspaceId, action.occurrenceId);
          if (!occurrenceContext || occurrenceContext.occurrence.version !== action.expectedVersion) throw new Error("target occurrence is missing or stale");
          if (["done", "skipped", "cancelled", "elapsed"].includes(occurrenceContext.occurrence.status)) throw new Error("terminal occurrence cannot be changed");
          if (action.operation === "skip" && !occurrenceContext.task.recurrenceRule) throw new Error("a one-time task cannot be skipped; cancel it instead");
          if (action.operation === "record_blocker" && !action.details?.trim()) throw new Error("blocker details are required");
          if (action.operation !== "record_blocker" && action.details !== null) throw new Error("details are only valid when recording a blocker");
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
        if (action.type === "complete_task") {
          const task = await this.tasks.getTask(scope.workspaceId, action.taskId);
          if (!task || task.version !== action.expectedVersion) throw new Error("target task is missing or stale");
          if (task.status !== "active") throw new Error("only an active task can be marked done");
          continue;
        }
        const occurrenceContext = await this.tasks.getOccurrenceContext(scope.workspaceId, action.occurrenceId);
        if (!occurrenceContext || occurrenceContext.occurrence.version !== action.expectedVersion) throw new Error("target occurrence is missing or stale");

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
    if (this.config.taskBatchEnabled) actions = normalizeEligibleTaskBatch(actions);
    const batchError = validateActionBatchShape(actions);
    if (batchError) throw new InvalidAiActionError(batchError);
    const { immediate, pending } = splitActionsByDisposition(actions);
    const result: ProposedActionsResult = {};
    const warnings: string[] = [];
    let newCriticalCount = actions.reduce((count, action) => count + (action.type === "create_task" && action.definition.importance === "critical" ? 1
      : action.type === "task_batch" ? action.steps.filter((step) => step.operation === "create" && step.definition.importance === "critical").length : 0), 0);
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

  /** The proposal a typed "да"/"нет" refers to, so an affirmative never re-derives its own target. */
  async latestPendingGroup(workspaceId: string, actorUserId: string, now = new Date()): Promise<{ groupId: string; createdAt: Date } | null> {
    return this.repository.findLatestPendingGroup(workspaceId, actorUserId, now);
  }

  async confirm(workspaceId: string, actorUserId: string, recipientUserId: string, groupId: string, now = new Date()): Promise<NonNullable<ProposedActionsResult["applied"]>> {
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
        const linkedGoals = await this.linkCreatedTaskGoals(workspaceId, groupId, createActions, created, now);
        await this.finalizeCreatedTasks(workspaceId, groupId, createActions, created, now);
        return createdTasksResult(groupId, createActions, created, linkedGoals);
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
      if (action.type === "task_batch") {
        const scope = { workspaceId, actorUserId, recipientUserId, now, ...(claimed.group.sourceMessageId ? { sourceMessageId: claimed.group.sourceMessageId } : {}) };
        const errors = await this.validate([action], scope);
        if (errors.length) throw new InvalidAiActionError(errors.join("; "));
        return this.applyTaskBatch(action, scope, groupId, true);
      }
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

    const mixedTaskBatch = (claimed.events.some((event) => event.actionType === "create_task") && !createOnly)
      || (claimed.events.some((event) => event.entityType === "task_goal") && !contextOnly);
    if (mixedTaskBatch) {
      try {
        const result = await this.taskBatches.undo({ workspaceId, groupId, events: claimed.events, now });
        for (const occurrenceId of result.reminderRebuildOccurrenceIds) {
          await this.reminders.rebuildOccurrence(workspaceId, occurrenceId).catch((error) => console.error("batch reminder rebuild deferred after undo", { occurrenceId, error: safeError(error) }));
        }
        return;
      } catch (error) {
        console.warn("task batch undo refused", { groupId, reasonCode: taskBatchFailureCode(error), error: safeError(error) });
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
    if (!this.config.taskBatchEnabled) await this.repository.cancelPendingTaskBatches(new Date()).catch((error) => console.error("pending task batch cancellation failed", safeError(error)));
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
    const taskBatch = actions.length === 1 && actions[0]?.type === "task_batch" ? actions[0] : null;
    if (taskBatch) return this.applyTaskBatch(taskBatch, { ...scope, now }, groupId, false);
    await this.repository.createImmediateGroup({ id: groupId, workspaceId: scope.workspaceId, actorUserId: scope.actorUserId, ...(scope.sourceMessageId ? { sourceMessageId: scope.sourceMessageId } : {}) });

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
      const linkedGoals = await this.linkCreatedTaskGoals(scope.workspaceId, groupId, createActions, created, now);
      await this.finalizeCreatedTasks(scope.workspaceId, groupId, createActions, created, now);
      return createdTasksResult(groupId, createActions, created, linkedGoals);
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
    const result = await this.applyClaimedMutationRaw(action, scope, groupId);
    return { ...result, items: result.items ?? mutationReportItems(action, result) };
  }

  private async applyClaimedMutationRaw(
    action: Exclude<ProposedActionDraft, { type: "create_task" | "create_goal_plan" }>,
    scope: ActionScope & { now: Date },
    groupId: string,
  ): Promise<Omit<import("./action-mutations.repository.js").MutationAppliedResult, "count"> & { count: number; linkedGoalTitles?: string[]; items?: AppliedReportItem[] }> {
    const undoExpiresAt = actionExpiry(scope.now, ACTION_UNDO_TTL_MS);
    if (action.type === "task_batch") return this.applyTaskBatch(action, scope, groupId, true);
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
    if (action.type === "update_settings") {
      const current = await this.settings.get(scope.actorUserId);
      if (!current || current.version !== action.expectedVersion) throw new Error("settings are stale or missing");
      const { patch, title } = this.settingsPatchForAction(action, current);
      const result = await this.mutations.applyUpdateSettings({
        workspaceId: scope.workspaceId, groupId, actorUserId: scope.actorUserId,
        expectedVersion: action.expectedVersion, patch, now: scope.now, undoExpiresAt,
      });
      return { ...result, titles: [title] };
    }
    if (action.type === "update_occurrence") {
      const occurrenceContext = await this.tasks.getOccurrenceContext(scope.workspaceId, action.occurrenceId);
      if (!occurrenceContext || occurrenceContext.occurrence.version !== action.expectedVersion) throw new Error("target occurrence is missing or stale");
      if (action.operation === "seen") {
        const result = await this.mutations.applyOccurrenceInteraction({
          workspaceId: scope.workspaceId, groupId, actorUserId: scope.actorUserId, occurrenceId: action.occurrenceId,
          expectedVersion: action.expectedVersion, operation: "seen", now: scope.now,
        });
        await this.reminders.scheduleSeenFallback({ workspaceId: scope.workspaceId, userId: scope.recipientUserId, occurrenceId: action.occurrenceId });
        return result;
      }
      if (action.operation === "record_blocker") {
        return this.mutations.applyOccurrenceInteraction({
          workspaceId: scope.workspaceId, groupId, actorUserId: scope.actorUserId, occurrenceId: action.occurrenceId,
          expectedVersion: action.expectedVersion, operation: "record_blocker", details: action.details!, now: scope.now,
        });
      }
      return this.mutations.applyUpdateOccurrence({
        workspaceId: scope.workspaceId, occurrenceId: action.occurrenceId, expectedVersion: action.expectedVersion,
        groupId, actorUserId: scope.actorUserId, operation: action.operation, now: scope.now, undoExpiresAt,
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
      if (result.reminderRebuildOccurrenceId) {
        const rebuilt = await this.reminders.rebuildOccurrence(scope.workspaceId, result.reminderRebuildOccurrenceId).then(() => true).catch((error) => {
          console.error("reminder rebuild deferred", { occurrenceId: result.reminderRebuildOccurrenceId, error: safeError(error) });
          return false;
        });
        if (rebuilt) {
          const scheduledReminderAt = await this.reminders.nextUserReminderAt(scope.workspaceId, result.reminderRebuildOccurrenceId).catch(() => null);
          if (scheduledReminderAt) result.scheduledReminderAt = scheduledReminderAt;
        }
      }
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
    if (action.type === "complete_task") {
      return this.mutations.applyCompleteTask({
        workspaceId: scope.workspaceId,
        groupId,
        actorUserId: scope.actorUserId,
        taskId: action.taskId,
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
      const rebuilt = await this.reminders.rebuildOccurrence(scope.workspaceId, result.reminderRebuildOccurrenceId).then(() => true).catch((error) => {
        console.error("reminder rebuild deferred", { occurrenceId: result.reminderRebuildOccurrenceId, error: safeError(error) });
        return false;
      });
      if (rebuilt) {
        const scheduledReminderAt = await this.reminders.nextUserReminderAt(scope.workspaceId, result.reminderRebuildOccurrenceId).catch(() => null);
        if (scheduledReminderAt) result.scheduledReminderAt = scheduledReminderAt;
      }
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
      return {
        groupId, count: created.length + 1, titles: [goal.title, ...action.tasks.map((task) => task.title)], linkedGoalTitles: [goal.title],
        items: [{ kind: "goal_plan" as const, goalTitle: goal.title, tasks: tasks.map((task, index) => createdTaskItem(task, created[index], null)) }],
      };
    } catch (error) {
      if (created.length) await this.tasks.undoCreatedTasks(scope.workspaceId, created.map((item) => ({ id: item.taskId, version: 1 }))).catch(() => undefined);
      if (goal) await this.contextActions.discardGoalPlanSeed(scope.workspaceId, goal.id).catch(() => undefined);
      throw error;
    }
  }

  private async applyTaskBatch(
    action: Extract<ProposedActionDraft, { type: "task_batch" }>,
    scope: ActionScope & { now: Date },
    groupId: string,
    groupExists: boolean,
  ) {
    compileTaskBatchShape(action);
    const createSteps = action.steps.filter((step): step is Extract<typeof step, { operation: "create" }> => step.operation === "create");
    const builtCreates = await this.tasks.prepareTaskPlans(createSteps.map((step) => createTaskInputFromAction(
      { ...step, type: "create_task" },
      { workspaceId: scope.workspaceId, actorUserId: scope.actorUserId, recipientUserId: scope.recipientUserId, sourceActionGroupId: groupId, now: scope.now },
    )));
    const builtByStep = new Map(createSteps.map((step, index) => [step.stepId, builtCreates[index]!]));
    const prepared: PreparedTaskBatchStep[] = action.steps.map((step) => {
      if (step.operation === "create") return { kind: "create", stepId: step.stepId, action: step, built: builtByStep.get(step.stepId)! };
      if (step.operation === "update") {
        validateUpdateTaskAction({ ...step, type: "update_task", taskId: step.target.kind === "persisted" ? step.target.taskId : scope.actorUserId, expectedVersion: step.target.kind === "persisted" ? step.target.expectedTaskVersion : 1 });
        return {
          kind: "update", stepId: step.stepId, target: step.target,
          patch: {
            ...(step.patch.title !== null ? { title: step.patch.title.trim() } : {}), ...(step.patch.why !== null ? { why: step.patch.why.trim() } : {}),
            ...(step.patch.nextAction !== null ? { nextAction: step.patch.nextAction.trim() } : {}), ...(step.patch.context !== null ? { context: step.patch.context.trim() } : {}),
            ...(step.patch.importance !== null ? { importance: step.patch.importance } : {}),
            ...(step.patch.checklist !== null ? { checklist: step.patch.checklist.map((item) => ({ text: item.text.trim(), done: item.done })) } : {}),
            ...(step.patch.habitMode !== null ? { habitMode: step.patch.habitMode } : {}),
            ...(step.patch.minimumAction !== null ? { minimumAction: step.patch.minimumAction.trim() } : {}),
            ...(step.patch.desiredAction !== null ? { desiredAction: step.patch.desiredAction.trim() } : {}),
            ...(step.patch.habitTrigger !== null ? { habitTrigger: step.patch.habitTrigger.trim() } : {}),
          },
        };
      }
      if (step.operation === "reschedule") return {
        kind: "reschedule", stepId: step.stepId, occurrenceId: step.occurrenceId, expectedVersion: step.expectedVersion,
        scheduleTimezone: step.schedule.timezone, schedule: rescheduleFieldsFromAction({ ...step, type: "reschedule_occurrence" }),
        ...(step.reason?.trim() ? { reason: step.reason.trim() } : {}),
      };
      return { kind: "link", stepId: step.stepId, target: step.target, goalId: step.goalId, expectedGoalVersion: step.expectedGoalVersion, source: step.source, confidence: step.confidence };
    });
    let applied: Awaited<ReturnType<TaskBatchRepository["apply"]>>;
    try {
      applied = await this.taskBatches.apply({
        workspaceId: scope.workspaceId, actorUserId: scope.actorUserId, groupId, groupExists, steps: prepared,
        ...(scope.sourceMessageId ? { sourceMessageId: scope.sourceMessageId } : {}),
        now: scope.now, undoExpiresAt: actionExpiry(scope.now, ACTION_UNDO_TTL_MS),
      });
    } catch (error) {
      console.warn("task batch application refused", { groupId, stepCount: prepared.length, reasonCode: taskBatchFailureCode(error), error: safeError(error) });
      throw error;
    }
    console.info("task batch applied", {
      groupId: applied.groupId,
      stepCount: applied.count,
      reminderRebuildCount: applied.reminderRebuildOccurrenceIds.length,
    });
    await this.tasks.enqueuePreparedTaskPlans(builtCreates);
    for (const occurrenceId of applied.reminderRebuildOccurrenceIds) {
      await this.reminders.rebuildOccurrence(scope.workspaceId, occurrenceId).catch((error) => {
        console.error("batch reminder rebuild deferred", { occurrenceId, error: safeError(error) });
      });
    }
    const items: AppliedReportItem[] = [];
    for (const [index, step] of action.steps.entries()) {
      const title = applied.titles[index] ?? "";
      if (step.operation === "create") {
        const built = builtByStep.get(step.stepId);
        if (built) items.push(createdTaskItem(step, built.result, null));
      } else if (step.operation === "update") {
        const patch = step.patch as Record<string, unknown>;
        const changes = (Object.keys(patch) as Array<import("../core/applied-report.js").TaskFieldChange["field"]>)
          .filter((field) => patch[field] !== null && patch[field] !== undefined)
          .map((field) => ({ field, before: null, after: field === "checklist" ? `${(patch[field] as unknown[]).length} пунктов` : field === "habitMode" ? (patch[field] ? "включён" : "выключен") : String(patch[field]) }));
        items.push({ kind: "task_updated", title, changes });
      } else if (step.operation === "reschedule") {
        items.push({ kind: "task_rescheduled", title, before: null, after: null, reminderAt: null, reason: step.reason ?? null });
      } else {
        items.push({ kind: "generic", title });
      }
    }
    return { groupId: applied.groupId, count: applied.count, titles: applied.titles, items };
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
    const batch = actions.length === 1 && actions[0]?.type === "task_batch" ? actions[0] : null;
    return { groupId, count: batch ? batch.steps.length : actions.length, titles: batch ? [...compileTaskBatchShape(batch).summaries] : actions.map(describeAction) };
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
  ): Promise<Array<string | null>> {
    const titles: Array<string | null> = [];
    for (const [index, action] of actions.entries()) {
      const goalLink = action.goalLink;
      const task = created[index];
      if (!goalLink || !task) { titles.push(null); continue; }
      titles.push(await this.contextActions.linkCreatedTaskToGoal({
        workspaceId, groupId, taskId: task.taskId, expectedTaskVersion: 1,
        goalId: goalLink.goalId, expectedGoalVersion: goalLink.expectedGoalVersion, confidence: goalLink.confidence,
      }));
    }
    return titles;
  }

  private async validateSettingsAction(action: Extract<ProposedActionDraft, { type: "update_settings" }>, userId: string, now: Date): Promise<void> {
    const current = await this.settings.get(userId);
    if (!current || current.version !== action.expectedVersion) throw new Error("settings are stale or missing");
    if (action.operation === "timezone") {
      if (!action.timezone) throw new Error("timezone is required");
      if (action.applyTimezoneTo === null) throw new Error("timezone scope is required");
      new Intl.DateTimeFormat("en", { timeZone: action.timezone }).format(now);
      return;
    }
    if (action.operation === "language") {
      if (action.language !== null && !action.language.trim()) throw new Error("language cannot be blank");
      if (action.language !== null) normalizeLanguageTag(action.language);
      return;
    }
    if (action.operation === "digest") {
      if (action.digestKind === null || action.enabled === null) throw new Error("digest kind and enabled state are required");
      if (action.time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/u.test(action.time)) throw new Error("digest time must be HH:MM");
      return;
    }
    if (action.operation === "weekly_review") {
      if (action.enabled === null) throw new Error("weekly review enabled state is required");
      if (action.enabled && (action.weekday === null || action.time === null)) throw new Error("weekly review requires weekday and time");
      if (action.time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/u.test(action.time)) throw new Error("weekly review time must be HH:MM");
      return;
    }
    if (action.operation === "quiet_hours") {
      if (action.enabled === null) throw new Error("quiet hours enabled state is required");
      const times = [action.weekdayStart, action.weekdayEnd, action.weekendStart, action.weekendEnd];
      if (action.enabled && times.some((value) => value === null)) throw new Error("enabled quiet hours require weekday and weekend ranges");
      if (times.some((value) => value !== null && !/^([01]\d|2[0-3]):[0-5]\d$/u.test(value))) throw new Error("quiet hours times must be HH:MM");
      return;
    }
    if (action.operation === "snooze") {
      if (action.snoozeUntil !== null) {
        const until = new Date(action.snoozeUntil);
        if (!Number.isFinite(until.getTime()) || until <= now) throw new Error("snoozeUntil must be a future ISO timestamp");
        if (until.getTime() - now.getTime() > 7 * 24 * 60 * 60_000) throw new Error("notification snooze cannot exceed 7 days");
      }
      return;
    }
    const values = [action.eventOffsets, action.plannedTaskOffsetMinutes, action.criticalPostDueMinutes, action.seenNormalMinutes, action.seenRequiredMinutes, action.seenCriticalMinutes];
    if (values.every((value) => value === null)) throw new Error("at least one reminder default is required");
    if (action.eventOffsets !== null && action.eventOffsets.length === 0) throw new Error("event offsets cannot be empty");
    for (const value of [action.criticalPostDueMinutes, action.seenNormalMinutes, action.seenRequiredMinutes, action.seenCriticalMinutes]) {
      if (value !== null && value < 15) throw new Error("critical and Seen intervals must be at least 15 minutes");
    }
  }

  private settingsPatchForAction(action: Extract<ProposedActionDraft, { type: "update_settings" }>, current: NonNullable<Awaited<ReturnType<SettingsService["get"]>>>) {
    if (action.operation === "timezone") {
      return { patch: { timezone: action.timezone!, ...(action.applyTimezoneTo === "all" ? { digestTimezone: action.timezone!, quietHoursTimezone: action.timezone! } : {}) }, title: "Изменить часовой пояс" };
    }
    if (action.operation === "language") {
      return { patch: { pinnedLanguage: action.language === null ? null : normalizeLanguageTag(action.language) }, title: "Изменить язык интерфейса" };
    }
    if (action.operation === "digest") {
      const patch = action.digestKind === "morning"
        ? { morningDigestEnabled: action.enabled!, digestTimezone: current.timezone, ...(action.time !== null ? { morningReferenceTime: action.time } : {}) }
        : { eveningDigestEnabled: action.enabled!, digestTimezone: current.timezone, ...(action.time !== null ? { eveningReferenceTime: action.time } : {}) };
      return { patch, title: action.digestKind === "morning" ? "Настроить утреннюю сводку" : "Настроить вечернюю сводку" };
    }
    if (action.operation === "weekly_review") {
      return { patch: { weeklyReviewEnabled: action.enabled!, digestTimezone: current.timezone, ...(action.weekday !== null ? { weeklyReviewWeekday: action.weekday } : {}), ...(action.time !== null ? { weeklyReviewTime: action.time } : {}) }, title: "Настроить еженедельный обзор" };
    }
    if (action.operation === "quiet_hours") {
      return { patch: { quietHoursEnabled: action.enabled!, quietHoursTimezone: current.timezone, ...(action.weekdayStart !== null ? { weekdayQuietStart: action.weekdayStart } : {}), ...(action.weekdayEnd !== null ? { weekdayQuietEnd: action.weekdayEnd } : {}), ...(action.weekendStart !== null ? { weekendQuietStart: action.weekendStart } : {}), ...(action.weekendEnd !== null ? { weekendQuietEnd: action.weekendEnd } : {}) }, title: "Настроить тихие часы" };
    }
    if (action.operation === "snooze") {
      return { patch: { notificationsSnoozedUntil: action.snoozeUntil === null ? null : new Date(action.snoozeUntil) }, title: action.snoozeUntil === null ? "Включить уведомления" : "Приостановить уведомления" };
    }
    return { patch: {
      ...(action.eventOffsets !== null ? { eventReminderOffsetsMinutes: [...new Set(action.eventOffsets)].sort((a, b) => a - b) } : {}),
      ...(action.plannedTaskOffsetMinutes !== null ? { plannedTaskReminderOffsetMinutes: action.plannedTaskOffsetMinutes } : {}),
      ...(action.criticalPostDueMinutes !== null ? { criticalPostDueMinutes: action.criticalPostDueMinutes } : {}),
      ...(action.seenNormalMinutes !== null ? { seenNormalMinutes: action.seenNormalMinutes } : {}),
      ...(action.seenRequiredMinutes !== null ? { seenRequiredMinutes: action.seenRequiredMinutes } : {}),
      ...(action.seenCriticalMinutes !== null ? { seenCriticalMinutes: action.seenCriticalMinutes } : {}),
    }, title: "Изменить стандартные напоминания" };
  }
}

/** Pending-confirmation wording: what will happen if the user taps Confirm, with the values the action carries. */
export function describeAction(action: ProposedActionDraft): string {
  if (action.type === "task_batch") return `Пакет из ${action.steps.length} действий`;
  if (action.type === "create_task") return `Создать «${action.title}»${describeLocalSchedule(action.definition.localSchedule)}`;
  if (action.type === "update_task") {
    const parts: string[] = [];
    if (action.patch.title !== null) parts.push(`название → «${action.patch.title}»`);
    if (action.patch.importance !== null) parts.push(`важность → ${action.patch.importance === "critical" ? "критическая" : action.patch.importance === "required" ? "обязательная" : "обычная"}`);
    if (action.patch.habitMode !== null) parts.push(action.patch.habitMode ? "включить режим привычки" : "выключить режим привычки");
    if (action.patch.checklist !== null) parts.push(`чеклист (${action.patch.checklist.length})`);
    if (action.patch.why !== null) parts.push("зачем");
    if (action.patch.nextAction !== null) parts.push("следующий шаг");
    if (action.patch.context !== null) parts.push("контекст");
    return parts.length ? `Изменить задачу: ${parts.join(", ")}` : "Изменить задачу";
  }
  if (action.type === "complete_task") return "Отметить выполненной";
  if (action.type === "reschedule_occurrence") return `Перенести${describeLocalSchedule(action.schedule.localSchedule)}${action.reason ? ` (${action.reason})` : ""}`;
  if (action.type === "create_goal") return `Создать цель «${action.title}»`;
  if (action.type === "create_goal_plan") return `Создать цель «${action.goal.title}» и ${action.tasks.length} задач`;
  if (action.type === "update_goal") return action.patch.status ? `Цель → ${action.patch.status === "completed" ? "завершена" : action.patch.status === "paused" ? "на паузе" : action.patch.status === "cancelled" ? "отменена" : "активна"}` : "Изменить цель";
  if (action.type === "save_memory") return `Запомнить${action.sensitive ? " (чувствительное)" : ""}: «${action.content.trim().slice(0, 120)}»`;
  if (action.type === "delete_memory") return "Удалить запись из памяти";
  if (action.type === "update_memory") return action.patch.content ? `Изменить запись в памяти: «${action.patch.content.trim().slice(0, 120)}»` : "Изменить запись в памяти";
  if (action.type === "change_reminder") {
    if (action.mode === "clear") return "Убрать напоминания";
    const reminder = action.reminder;
    const when = reminder?.triggerKind === "relative_timestamp" && reminder.offsetMinutes !== null
      ? ` ${reminder.offsetMinutes < 0 ? `за ${Math.abs(reminder.offsetMinutes)} мин до` : reminder.offsetMinutes > 0 ? `через ${reminder.offsetMinutes} мин после` : "в момент"} ${reminder.anchor === "due_at" ? "срока" : reminder.anchor === "planned_end" ? "конца" : "начала"}`
      : reminder?.triggerKind === "local_date" && reminder.localTime ? ` в ${reminder.localTime}${reminder.daysOffset ? ` (${reminder.daysOffset > 0 ? "+" : ""}${reminder.daysOffset} дн)` : ""}`
      : reminder?.exactAt ? ` ${reminder.exactAt}` : "";
    return `${action.mode === "add" ? "Добавить напоминание" : "Заменить напоминание"}${when}${reminder?.quietPolicy === "bypass" ? " — игнорируя тихие часы" : ""}`;
  }
  if (action.type === "change_series") return `Серия: ${action.operation === "pause" ? "поставить на паузу" : action.operation === "resume" ? "возобновить" : action.operation === "stop" ? "остановить" : action.operation === "cancel" ? "отменить" : "изменить расписание"}`;
  if (action.type === "update_settings") return `Изменить настройки: ${action.operation === "timezone" ? `часовой пояс → ${action.timezone}` : action.operation === "language" ? "язык" : action.operation === "digest" ? "дайджест" : action.operation === "weekly_review" ? "недельный обзор" : action.operation === "quiet_hours" ? "тихие часы" : action.operation === "snooze" ? "пауза уведомлений" : "напоминания по умолчанию"}`;
  if (action.type === "update_occurrence") return action.operation === "start" ? "Начать" : action.operation === "skip" ? "Пропустить" : action.operation === "cancel" ? "Отменить" : action.operation === "seen" ? "Отметить увиденной" : `Записать блокер: «${(action.details ?? "").trim().slice(0, 120)}»`;
  return "Связать задачу с целью";
}

function describeLocalSchedule(schedule: StructuredLocalScheduleInput | null | undefined): string {
  if (!schedule) return "";
  const date = (value: string | null) => value ? value.split("-").slice(1).reverse().join(".") : "";
  if (schedule.mode === "fuzzy") return schedule.fuzzyHorizonText ? ` — ${schedule.fuzzyHorizonText}` : "";
  if (schedule.mode === "deadline") return schedule.dueDate ? ` — до ${date(schedule.dueDate)}${schedule.dueTime ? ` ${schedule.dueTime}` : ""}` : "";
  if (!schedule.startDate) return "";
  const end = schedule.mode === "window" ? (schedule.endTime ? `–${schedule.endTime}` : schedule.durationMinutes ? ` (${schedule.durationMinutes} мин)` : "") : "";
  return ` — ${date(schedule.startDate)}${schedule.startTime ? ` ${schedule.startTime}` : ""}${end}`;
}

function normalizeEligibleTaskBatch(actions: readonly ProposedActionDraft[]): readonly ProposedActionDraft[] {
  if (actions.length <= 1 || !actions.every((action) => action.type === "create_task")) return actions;
  const creates = actions as readonly Extract<ProposedActionDraft, { type: "create_task" }>[];
  return [{
    type: "task_batch",
    source: creates.every((action) => action.source === "user_explicit") ? "user_explicit" : "ai_inferred",
    confidence: Math.min(...creates.map((action) => action.confidence)),
    steps: creates.map((action, index) => {
      const { type: _type, ...draft } = action;
      return { ...draft, operation: "create" as const, stepId: `legacy_create_${index + 1}` };
    }),
  }];
}

function taskBatchFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/stale|changed|version|claimable/i.test(message)) return "optimistic_conflict";
  if (/missing/i.test(message)) return "missing_target";
  if (/already linked|duplicate|unique/i.test(message)) return "duplicate_relation";
  if (/workspace|member|foreign key/i.test(message)) return "workspace_scope";
  if (/reminder|reschedul/i.test(message)) return "schedule_conflict";
  return "invalid_batch";
}


export { InvalidAiActionError };

function createdTaskItem(
  action: Pick<Extract<ProposedActionDraft, { type: "create_task" }>, "title" | "definition">,
  created: { occurrenceSchedule?: OccurrenceScheduleView; reminderSchedules: Array<{ scheduledFor: Date; purpose: string }> } | undefined,
  goalTitle: string | null,
): Extract<AppliedReportItem, { kind: "task_created" }> {
  const reminderAt = created?.reminderSchedules
    .filter((item) => item.purpose === "user_reminder")
    .map((item) => item.scheduledFor)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  return {
    kind: "task_created",
    title: action.title,
    timezone: action.definition.timezone,
    importance: action.definition.importance,
    recurring: Boolean(action.definition.recurrence || action.definition.recurrenceRule),
    schedule: created?.occurrenceSchedule ?? null,
    fuzzyHorizonText: action.definition.localSchedule?.fuzzyHorizonText ?? action.definition.fuzzyHorizonText ?? null,
    reviewAt: action.definition.reviewAt ? new Date(action.definition.reviewAt) : reviewAtFromLocalSchedule(action.definition),
    reminderAt,
    goalTitle,
  };
}

function reviewAtFromLocalSchedule(definition: Extract<ProposedActionDraft, { type: "create_task" }>["definition"]): Date | null {
  const schedule = definition.localSchedule;
  if (!schedule?.reviewDate || !schedule.reviewTime) return null;
  try {
    return localDateAndTimeToUtc(schedule.reviewDate, schedule.reviewTime, schedule.timezone).date;
  } catch {
    return null;
  }
}

function createdTasksResult(
  groupId: string,
  actions: Array<Extract<ProposedActionDraft, { type: "create_task" }>>,
  created: Awaited<ReturnType<TasksService["createTasks"]>>,
  linkedGoals: ReadonlyArray<string | null>,
): NonNullable<ProposedActionsResult["applied"]> {
  const linkedGoalTitles = linkedGoals.filter((title): title is string => Boolean(title));
  const scheduledReminderAt = created[0]?.reminderSchedules.find((item) => item.purpose === "user_reminder")?.scheduledFor;
  const occurrenceSchedule = created[0]?.occurrenceSchedule;
  return {
    groupId, count: created.length, titles: actions.map((action) => action.title),
    ...(scheduledReminderAt ? { scheduledReminderAt } : {}),
    ...(occurrenceSchedule ? { occurrenceSchedule } : {}),
    ...(linkedGoalTitles.length ? { linkedGoalTitles } : {}),
    items: actions.map((action, index) => createdTaskItem(action, created[index], linkedGoals[index] ?? null)),
  };
}

/** Report items for a single mutation, from the action that was applied plus what the repository returned. */
export function mutationReportItems(
  action: Exclude<ProposedActionDraft, { type: "create_task" | "create_goal_plan" }>,
  result: Omit<import("./action-mutations.repository.js").MutationAppliedResult, "count"> & { count: number },
): AppliedReportItem[] {
  const title = result.titles[0] ?? "";
  switch (action.type) {
    case "update_task":
      return [{ kind: "task_updated", title, changes: result.changes ?? [] }];
    case "reschedule_occurrence":
      return [{ kind: "task_rescheduled", title, before: result.previousSchedule ?? null, after: result.occurrenceSchedule ?? null, reminderAt: result.scheduledReminderAt ?? null, reason: action.reason ?? null }];
    case "complete_task":
      return [{ kind: "occurrence", title, operation: "done" }];
    case "update_occurrence":
      return [{ kind: "occurrence", title, operation: action.operation, details: action.details ?? null }];
    case "change_reminder":
      return [{ kind: "reminder", title, mode: action.mode, schedule: result.occurrenceSchedule ?? null, reminderAt: result.scheduledReminderAt ?? null }];
    case "change_series":
      return [{ kind: "series", title, operation: action.operation }];
    case "create_goal":
      return [{ kind: "goal_created", title }];
    case "update_goal":
      return [{ kind: "goal_updated", title }];
    case "save_memory":
      return [{ kind: "memory", operation: "saved", content: action.content }];
    case "update_memory":
      return [{ kind: "memory", operation: "updated", content: action.patch.content ?? title }];
    case "delete_memory":
      return [{ kind: "memory", operation: "deleted", content: title }];
    case "link_task_to_goal": {
      const match = title.match(/^Связать «(.+)» с целью «(.+)»$/u);
      return match ? [{ kind: "goal_linked", taskTitle: match[1]!, goalTitle: match[2]! }] : [{ kind: "generic", title }];
    }
    case "update_settings":
      return [{ kind: "settings", operation: action.operation }];
    default:
      return result.titles.map((item) => ({ kind: "generic", title: item }));
  }
}
