import { randomUUID } from "node:crypto";
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { ResolvedActionSchema, type AiAction, type ResolvedAction, type ResolvedActionOf, type TaskTarget } from "../core/ai-contract.js";
import { AI_ACTION_TYPES } from "../core/ai-contract.js";
import { ACTION_CONFIRMATION_TTL_MS, ACTION_UNDO_TTL_MS, actionExpiry } from "../core/action-lifecycle.js";
import { groupDisposition, isUndoable, type ActionIssue } from "../core/ai-actions.js";
import type { RefMap } from "../core/ai-refs.js";
import { habitOfferEligible } from "../core/habit-policy.js";
import { validateOneTimeTaskTiming } from "../core/task-policy.js";
import { rescheduledDefinition, rescheduledOccurrenceStatus } from "../core/reschedule.js";
import { normalizeLanguageTag } from "../core/language.js";
import { localDateAndTimeToUtc } from "../core/timezone.js";
import type { AppliedReportItem } from "../core/applied-report.js";
import { ContextActionsRepository } from "../context/context-actions.repository.js";
import { ContextService } from "../context/context.service.js";
import { taskDefinitionFromRow } from "../tasks/task-record-mappers.js";
import { TasksService } from "../tasks/tasks.service.js";
import { ReminderSchedulingService } from "../reminders/reminder-scheduling.service.js";
import { safeError } from "../observability/safe-error.js";
import { SettingsService } from "../settings/settings.service.js";
import {
  createTaskInputFromBody, InvalidAiActionError, reminderRuleFromReminder, rescheduleFieldsFromWhen,
  seriesDefinitionFromReschedule, taskDefinitionFromBody, validateUpdateTaskPatch, type ScheduleContext,
} from "./action-conversion.js";
import { describeAction, settingsPatchForAction } from "./action-describe.js";
import { resolveActions } from "./action-resolver.js";
import { ActionGroupRepository, type ActionGroupStep, type ActionGroupStepResult } from "./action-group.repository.js";
import { ActionMutationsRepository } from "./action-mutations.repository.js";
import { ActionsRepository } from "./actions.repository.js";

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
    /** False for interaction-only actions such as Seen that have no reversible state transition. */
    undoable?: boolean;
    count: number;
    titles: string[];
    /** Persisted facts for the user-facing applied report. */
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

const KNOWN_ACTION_TYPES = new Set<string>(AI_ACTION_TYPES);

@Injectable()
export class ActionsService implements OnApplicationBootstrap {
  constructor(
    private readonly repository: ActionsRepository,
    private readonly mutations: ActionMutationsRepository,
    private readonly groups: ActionGroupRepository,
    private readonly tasks: TasksService,
    private readonly reminders: ReminderSchedulingService,
    private readonly context: ContextService,
    private readonly contextActions: ContextActionsRepository,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Short ids and versions become server-resolved actions, then every domain rule runs.
   * Issues are returned, never thrown: the chat layer answers them deterministically.
   */
  async prepare(actions: readonly AiAction[], refs: RefMap, scope: Omit<ActionScope, "sourceMessageId">): Promise<{ resolved: ResolvedAction[]; issues: ActionIssue[] }> {
    const now = scope.now ?? new Date();
    const { resolved, issues } = await resolveActions(actions, refs, {
      findTask: async (taskId) => {
        const task = await this.tasks.getTask(scope.workspaceId, taskId);
        return task ? { id: task.id, version: task.version, status: task.status, timeMode: task.timeMode, timezone: task.timezone, recurrenceRule: task.recurrenceRule } : null;
      },
      findCurrentOccurrence: async (taskId, opts) => {
        const occurrence = await this.tasks.findCurrentOccurrence(scope.workspaceId, taskId, opts);
        return occurrence ? { id: occurrence.id, version: occurrence.version, status: occurrence.status, timezone: occurrence.timezone } : null;
      },
      findGoal: async (goalId) => {
        const goal = await this.context.findGoal(scope.workspaceId, goalId);
        return goal ? { id: goal.id, version: goal.version, status: goal.status } : null;
      },
      findMemory: async (memoryId) => {
        const memory = await this.context.findMemory(scope.workspaceId, scope.actorUserId, memoryId);
        return memory ? { id: memory.id, version: memory.version } : null;
      },
      findTaskGoalLink: (taskId, goalId) => this.context.findTaskGoalLink(scope.workspaceId, taskId, goalId),
      settings: async () => {
        const current = await this.settings.get(scope.actorUserId);
        if (!current) throw new InvalidAiActionError("settings are stale or missing", "settings_stale");
        return { version: current.version, timezone: current.timezone, morningReferenceTime: current.morningReferenceTime };
      },
    }, now);
    const domainIssues = await this.validate(resolved, { ...scope, now });
    return { resolved, issues: [...issues, ...domainIssues] };
  }

  /** Domain rules that need the current stored state; one issue per action index. */
  async validate(actions: readonly ResolvedAction[], scope: Omit<ActionScope, "sourceMessageId">): Promise<ActionIssue[]> {
    const now = scope.now ?? new Date();
    const issues: ActionIssue[] = [];
    for (const [index, action] of actions.entries()) {
      try {
        await this.validateOne(action, { ...scope, now });
      } catch (error) {
        const code = error instanceof InvalidAiActionError ? error.code : "invalid_action";
        const message = error instanceof Error ? error.message : "invalid action";
        issues.push({ kind: /stale|missing/i.test(message) ? "reference" : "domain", index, code, message });
      }
    }
    return issues;
  }

  private async validateOne(action: ResolvedAction, scope: Required<Pick<ActionScope, "now">> & Omit<ActionScope, "sourceMessageId" | "now">): Promise<void> {
    const ctx = scheduleContext(action);
    switch (action.type) {
      case "create_task":
        createTaskInputFromBody(action.body, { ...scope, recipientUserId: scope.recipientUserId, now: scope.now }, ctx);
        return;
      case "plan":
        if (!action.tasks.length) throw new InvalidAiActionError("goal plan requires at least one task", "plan_empty");
        for (const task of action.tasks) createTaskInputFromBody(task, { ...scope, recipientUserId: scope.recipientUserId, now: scope.now }, ctx);
        return;
      case "update_task": {
        validateUpdateTaskPatch(action.patch);
        const task = await this.tasks.getTask(scope.workspaceId, action.taskId);
        if (!task || task.version !== action.taskVersion) throw new InvalidAiActionError("target task is missing or stale", "stale");
        const enablesHabit = action.patch.habit !== null && "minimumAction" in action.patch.habit;
        if (enablesHabit) {
          if (!task.recurrenceRule) throw new InvalidAiActionError("habit mode requires a recurring task", "habit_not_eligible");
          if (task.habitMode) throw new InvalidAiActionError("task is already a habit", "habit_not_eligible");
          if (action.intent === "inferred" && !habitOfferEligible({ recurring: true, kind: task.kind, alreadyHabit: task.habitMode, offeredBefore: Boolean(task.habitOfferSentAt), behavioral: true })) {
            throw new InvalidAiActionError("habit mode is not eligible or was already offered for this task", "habit_not_eligible");
          }
        }
        return;
      }
      case "set_task_state": {
        if (action.target.kind === "occurrence") {
          const context = await this.tasks.getOccurrenceContext(scope.workspaceId, action.target.occurrenceId);
          if (!context || context.occurrence.version !== action.target.occurrenceVersion) throw new InvalidAiActionError("target occurrence is missing or stale", "stale");
          if (action.state !== "done" && ["done", "skipped", "cancelled", "elapsed"].includes(context.occurrence.status)) {
            throw new InvalidAiActionError("terminal occurrence cannot be changed", "terminal_occurrence");
          }
        }
        if (action.state === "seen" && action.note !== null && !action.note.trim()) throw new InvalidAiActionError("blocker details are required", "blank_field");
        if (action.state !== "seen" && action.note !== null) throw new InvalidAiActionError("details are only valid when recording a blocker", "note_not_allowed");
        const task = await this.tasks.getTask(scope.workspaceId, action.target.taskId);
        if (!task || task.version !== action.target.taskVersion) throw new InvalidAiActionError("target task is missing or stale", "stale");
        if (action.state === "done" && task.status !== "active") throw new InvalidAiActionError("only an active task can be marked done", "task_not_active");
        return;
      }
      case "reschedule": {
        const { fields, timeMode } = rescheduleFieldsFromWhen(action.when, ctx);
        if (action.target.kind === "series") {
          const task = await this.tasks.getTask(scope.workspaceId, action.target.taskId);
          if (!task || task.version !== action.target.taskVersion) throw new InvalidAiActionError("series task is missing or stale", "stale");
          if (!task.recurrenceRule) throw new InvalidAiActionError("task is not a recurring series", "not_recurring");
          seriesDefinitionFromReschedule(action, taskDefinitionFromRow(task));
          return;
        }
        const task = await this.tasks.getTask(scope.workspaceId, action.target.taskId);
        if (!task || task.version !== action.target.taskVersion) throw new InvalidAiActionError("target task is missing or stale", "stale");
        const next = rescheduledDefinition(taskDefinitionFromRow(task), fields, timeMode);
        const timingErrors = validateOneTimeTaskTiming(next, scope.now, "rescheduling a one-time task");
        if (timingErrors.length) throw new InvalidAiActionError(timingErrors.join("; "), "time_past");
        if (action.target.kind === "occurrence") {
          const context = await this.tasks.getOccurrenceContext(scope.workspaceId, action.target.occurrenceId);
          if (!context || context.occurrence.version !== action.target.occurrenceVersion) throw new InvalidAiActionError("target occurrence is missing or stale", "stale");
          if (["done", "skipped", "cancelled"].includes(context.occurrence.status)) throw new InvalidAiActionError("terminal occurrence cannot be rescheduled", "terminal_occurrence");
          if (await this.tasks.isRescheduleReasonRequired(scope.workspaceId, action.target.occurrenceId) && !action.reason?.trim()) {
            throw new InvalidAiActionError("reschedule reason is required", "reason_required");
          }
        } else {
          rescheduledOccurrenceStatus(next, scope.now);
        }
        return;
      }
      case "set_reminder": {
        if (action.target.kind !== "occurrence") throw new InvalidAiActionError("a task without a date cannot carry a reminder", "fuzzy_reminder");
        const context = await this.tasks.getOccurrenceContext(scope.workspaceId, action.target.occurrenceId);
        if (!context || context.occurrence.version !== action.target.occurrenceVersion) throw new InvalidAiActionError("target occurrence is missing or stale", "stale");
        const rule = action.reminder ? reminderRuleFromReminder(action.reminder, action.target.timezone) : undefined;
        if (rule?.exactAt && rule.exactAt <= scope.now) throw new InvalidAiActionError("reminder must be in the future", "time_past");
        await this.reminders.validateExplicitReminderChange({
          workspaceId: scope.workspaceId, userId: scope.recipientUserId, occurrenceId: action.target.occurrenceId, mode: action.mode,
          ...(rule ? { rule } : {}), now: scope.now,
        });
        return;
      }
      case "goal": {
        if (action.op === "create") {
          if (!action.title?.trim()) throw new InvalidAiActionError("goal title is required", "goal_title");
          return;
        }
        const goal = await this.context.findGoal(scope.workspaceId, action.goalId!);
        if (!goal || goal.version !== action.goalVersion) throw new InvalidAiActionError("target goal is missing or stale", "stale");
        if (action.op === "update") {
          if (action.title !== null && !action.title.trim()) throw new InvalidAiActionError("goal title cannot be blank", "blank_field");
          if (action.why !== null && !action.why.trim()) throw new InvalidAiActionError("goal why cannot be blank", "blank_field");
          return;
        }
        if (goal.status !== "active" && action.op === "link") throw new InvalidAiActionError("target goal is missing or stale", "stale");
        const task = await this.tasks.getTask(scope.workspaceId, action.taskId!);
        if (!task || task.version !== action.taskVersion) throw new InvalidAiActionError("target task is missing or stale", "stale");
        return;
      }
      case "memory": {
        if (action.op === "save") {
          if (!action.content?.trim()) throw new InvalidAiActionError("memory content is required", "memory_shape");
          return;
        }
        const memory = await this.context.findMemory(scope.workspaceId, scope.actorUserId, action.memoryId!);
        if (!memory || memory.version !== action.memoryVersion) throw new InvalidAiActionError("memory is missing or stale", "stale");
        return;
      }
      case "settings":
        await this.validateSettingsAction(action, scope.actorUserId, scope.now);
        return;
    }
  }

  /** One message is one package: a single applied group or a single confirmation card. */
  async handleProposed(actions: readonly ResolvedAction[], scope: ActionScope): Promise<ProposedActionsResult> {
    if (!actions.length) return {};
    const warnings = await this.criticalWarnings(actions, scope);
    if (groupDisposition(actions) === "confirm") {
      const pending = await this.storePending(actions, scope);
      return { pending, ...(warnings.length ? { warnings } : {}) };
    }
    const applied = await this.applyResolved(actions, scope);
    return { applied, ...(warnings.length ? { warnings } : {}) };
  }

  /** Apply without a confirmation gate; also the entry point for deterministic button flows. */
  async applyResolved(actions: readonly ResolvedAction[], scope: ActionScope, groupId: string = randomUUID(), groupExists = false): Promise<NonNullable<ProposedActionsResult["applied"]>> {
    const now = scope.now ?? new Date();
    const steps = await this.prepareSteps(actions, { ...scope, now }, groupId);
    let result;
    try {
      result = await this.groups.apply({
        workspaceId: scope.workspaceId, actorUserId: scope.actorUserId, groupId, groupExists,
        ...(scope.sourceMessageId ? { sourceMessageId: scope.sourceMessageId } : {}),
        steps, now, undoExpiresAt: actionExpiry(now, ACTION_UNDO_TTL_MS),
      });
    } catch (error) {
      if (groupExists) await this.repository.markFailed(scope.workspaceId, groupId).catch(() => undefined);
      throw error;
    }
    await this.afterCommit(result, actions, scope, now);
    const items = await this.reportItems(result.steps, scope, actions);
    return {
      groupId, count: actions.length, titles: result.steps.map(stepTitle).filter((title): title is string => Boolean(title)),
      undoable: isUndoable(actions), items,
    };
  }

  /** Deterministic series buttons (pause/cancel) bypass the model but share the journal. */
  async applySeriesOperation(scope: ActionScope, taskId: string, expectedVersion: number, operation: "pause" | "resume" | "stop" | "cancel"): Promise<ProposedActionsResult> {
    const now = scope.now ?? new Date();
    const groupId = randomUUID();
    const result = await this.groups.apply({
      workspaceId: scope.workspaceId, actorUserId: scope.actorUserId, groupId, groupExists: false,
      steps: [{ kind: "change_series", taskId, expectedVersion, operation }], now, undoExpiresAt: actionExpiry(now, ACTION_UNDO_TTL_MS),
    });
    for (const id of result.reconcileTaskIds) await this.tasks.reconcileRecurringTask(scope.workspaceId, id, now).catch((error) => console.error("series reconciliation deferred", { taskId: id, error: safeError(error) }));
    const items = await this.reportItems(result.steps, scope, []);
    return { applied: { groupId, count: 1, titles: result.steps.map(stepTitle).filter((title): title is string => Boolean(title)), items } };
  }

  async confirm(workspaceId: string, actorUserId: string, recipientUserId: string, groupId: string, now = new Date()): Promise<NonNullable<ProposedActionsResult["applied"]>> {
    const claimed = await this.repository.claimPendingGroup(workspaceId, actorUserId, groupId, now);
    if (!claimed) throw new Error("confirmation expired or already handled");
    let actions: ResolvedAction[];
    try {
      actions = claimed.actions.map((row) => ResolvedActionSchema.parse(row.payload) as ResolvedAction);
    } catch (error) {
      await this.repository.markFailed(workspaceId, groupId).catch(() => undefined);
      throw error;
    }
    const scope: ActionScope = {
      workspaceId, actorUserId, recipientUserId, now,
      ...(claimed.group.sourceMessageId ? { sourceMessageId: claimed.group.sourceMessageId } : {}),
    };
    const issues = await this.validate(actions, scope);
    if (issues.length) {
      await this.repository.markFailed(workspaceId, groupId).catch(() => undefined);
      throw new InvalidAiActionError(issues.map((issue) => issue.message).join("; "), issues[0]?.code ?? "invalid_action");
    }
    return this.applyResolved(actions, scope, groupId, true);
  }

  async cancel(workspaceId: string, actorUserId: string, groupId: string): Promise<boolean> {
    return this.repository.cancelPendingGroup(workspaceId, actorUserId, groupId);
  }

  /** The proposal a typed "да"/"нет" refers to, resolved from the card the bot actually sent. */
  async pendingGroupSummary(workspaceId: string, actorUserId: string, groupId: string, now = new Date()): Promise<{ groupId: string; createdAt: Date; titles: string[] } | null> {
    const group = await this.repository.findPendingGroup(workspaceId, actorUserId, groupId, now);
    if (!group) return null;
    const titles = group.actions.map((row) => {
      const parsed = ResolvedActionSchema.safeParse(row.payload);
      return parsed.success ? describeAction(parsed.data) : row.actionType;
    });
    return { groupId: group.groupId, createdAt: group.createdAt, titles };
  }

  async undo(workspaceId: string, actorUserId: string, groupId: string, now = new Date()): Promise<void> {
    const claimed = await this.repository.claimUndo(workspaceId, actorUserId, groupId, now);
    if (!claimed) throw new Error("undo expired or action already changed");
    let result;
    try {
      result = await this.groups.undo({ workspaceId, groupId, now });
    } catch (error) {
      await this.repository.releaseUndoClaim(workspaceId, groupId).catch(() => undefined);
      throw error;
    }
    for (const occurrenceId of result.reminderRebuildOccurrenceIds) {
      await this.reminders.rebuildOccurrence(workspaceId, occurrenceId).catch((error) => console.error("reminder rebuild deferred after undo", { occurrenceId, error: safeError(error) }));
    }
    for (const taskId of result.fuzzyRebuildTaskIds) {
      await this.reminders.rebuildFuzzyTask(workspaceId, actorUserId, taskId, now).catch((error) => console.error("planning reminder rebuild deferred after undo", { taskId, error: safeError(error) }));
    }
    for (const taskId of result.reconcileTaskIds) {
      await this.tasks.reconcileRecurringTask(workspaceId, taskId, now).catch((error) => console.error("series reconciliation deferred after undo", { taskId, error: safeError(error) }));
    }
  }

  async cleanupExpiredConfirmations(now = new Date()): Promise<number> {
    return this.repository.expirePendingGroups(now);
  }

  async cleanupExpiredAuditPayloads(now = new Date()): Promise<number> {
    return this.repository.scrubExpiredActionPayloads(now);
  }

  async onApplicationBootstrap(): Promise<void> {
    // A card stored under an older action contract can no longer be applied truthfully.
    await this.repository.expireLegacyPendingGroups(new Date(), (actionType, payload) =>
      KNOWN_ACTION_TYPES.has(actionType) && ResolvedActionSchema.safeParse(payload).success,
    ).catch((error) => console.error("legacy pending action expiry failed", safeError(error)));
    await this.recoverInterruptedActions();
  }

  async recoverInterruptedActions(now = new Date()): Promise<void> {
    const groups = await this.repository.listRecoveryGroups();
    for (const group of groups) {
      try {
        // Every group commits its state, journal and finalization in one transaction, so a
        // surviving in-progress row means that transaction never committed.
        if (group.status === "applying") await this.repository.markFailed(group.workspaceId, group.id);
        else await this.repository.releaseUndoClaim(group.workspaceId, group.id);
      } catch (error) {
        console.error("action recovery failed", { groupId: group.id, status: group.status, error: safeError(error) });
      }
    }
    await this.repository.expirePendingGroups(now).catch((error) => console.error("pending action cleanup failed", safeError(error)));
  }

  private async criticalWarnings(actions: readonly ResolvedAction[], scope: ActionScope): Promise<string[]> {
    let newCritical = 0;
    for (const action of actions) {
      if (action.type === "create_task" && action.body.importance === "critical") newCritical += 1;
      if (action.type === "plan") newCritical += action.tasks.filter((task) => task.importance === "critical").length;
      if (action.type === "update_task" && action.patch.importance === "critical") {
        const existing = await this.tasks.getTask(scope.workspaceId, action.taskId);
        if (existing && existing.importance !== "critical") newCritical += 1;
      }
    }
    if (!newCritical) return [];
    const active = await this.tasks.countActiveCritical(scope.workspaceId);
    return active + newCritical > 3 ? ["Активных критических задач станет больше трёх. Это может заметно увеличить давление напоминаний."] : [];
  }

  private async storePending(actions: readonly ResolvedAction[], scope: ActionScope): Promise<NonNullable<ProposedActionsResult["pending"]>> {
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
      if (action.type !== "update_task" || action.intent !== "inferred") continue;
      if (action.patch.habit === null || !("minimumAction" in action.patch.habit)) continue;
      const marked = await this.tasks.markHabitOfferSent(scope.workspaceId, action.taskId, now);
      if (!marked) {
        await this.repository.cancelPendingGroup(scope.workspaceId, scope.actorUserId, groupId).catch(() => undefined);
        throw new InvalidAiActionError("habit mode was already offered for this task", "habit_not_eligible");
      }
    }
    return { groupId, count: actions.length, titles: actions.map(describeAction) };
  }

  /** Pure-ish compilation outside the transaction: task plans and definitions are built first. */
  private async prepareSteps(actions: readonly ResolvedAction[], scope: Required<Pick<ActionScope, "now">> & ActionScope, groupId: string): Promise<ActionGroupStep[]> {
    const steps: ActionGroupStep[] = [];
    for (const action of actions) {
      const ctx = scheduleContext(action);
      const linkSource = action.intent === "explicit" ? "user_explicit" as const : "ai_inferred" as const;
      switch (action.type) {
        case "create_task": {
          const [built] = await this.tasks.prepareTaskPlans([createTaskInputFromBody(action.body, { ...scope, sourceActionGroupId: groupId, now: scope.now }, ctx)]);
          if (!built) throw new InvalidAiActionError("task plan could not be prepared", "invalid_action");
          steps.push({ kind: "create_task", plan: built.plan, goalLink: action.goal ? { goalId: action.goal.goalId, goalVersion: action.goal.goalVersion, source: linkSource, confidence: action.intent === "explicit" ? 1 : 0.9 } : null });
          break;
        }
        case "plan": {
          const built = await this.tasks.prepareTaskPlans(action.tasks.map((task) => createTaskInputFromBody(task, { ...scope, sourceActionGroupId: groupId, now: scope.now }, ctx)));
          steps.push({
            kind: "goal_plan",
            goal: { title: action.goal.title, ...(action.goal.why ? { why: action.goal.why } : {}), ...(action.goal.targetDate ? { targetLocalDate: action.goal.targetDate } : {}) },
            plans: built.map((item) => item.plan), source: linkSource,
          });
          break;
        }
        case "update_task":
          steps.push({ kind: "update_task", taskId: action.taskId, expectedVersion: action.taskVersion, patch: updateTaskPatchForRepository(action) });
          break;
        case "set_task_state":
          steps.push(taskStateStep(action));
          break;
        case "reschedule": {
          const { fields, timeMode } = rescheduleFieldsFromWhen(action.when, ctx);
          if (action.target.kind === "series") {
            const task = await this.tasks.getTask(scope.workspaceId, action.target.taskId);
            if (!task) throw new InvalidAiActionError("series task is missing or stale", "stale");
            steps.push({ kind: "change_series", taskId: action.target.taskId, expectedVersion: action.target.taskVersion, operation: "edit", editDefinition: seriesDefinitionFromReschedule(action, taskDefinitionFromRow(task)) });
            break;
          }
          if (action.target.kind === "occurrence") {
            steps.push({
              kind: "reschedule_occurrence", occurrenceId: action.target.occurrenceId, expectedVersion: action.target.occurrenceVersion,
              scheduleTimezone: action.target.timezone, schedule: fields, timeMode, ...(action.reason ? { reason: action.reason } : {}),
            });
            break;
          }
          // A task with no occurrence becomes concrete: the first occurrence and its default
          // reminders are created in the same transaction as the schedule change.
          const task = await this.tasks.getTask(scope.workspaceId, action.target.taskId);
          if (!task) throw new InvalidAiActionError("target task is missing or stale", "stale");
          const definition = rescheduledDefinition(taskDefinitionFromRow(task), fields, timeMode);
          steps.push({
            kind: "concretise_task", taskId: action.target.taskId, expectedVersion: action.target.taskVersion,
            definition, occurrenceStatus: rescheduledOccurrenceStatus(definition, scope.now),
            ...(action.reason ? { reason: action.reason } : {}),
          });
          break;
        }
        case "set_reminder": {
          if (action.target.kind !== "occurrence") throw new InvalidAiActionError("a task without a date cannot carry a reminder", "fuzzy_reminder");
          steps.push({
            kind: "change_reminder", occurrenceId: action.target.occurrenceId, expectedVersion: action.target.occurrenceVersion, mode: action.mode,
            ...(action.reminder ? { rule: reminderRuleFromReminder(action.reminder, action.target.timezone) } : {}),
          });
          break;
        }
        case "goal":
          if (action.op === "create") {
            steps.push({ kind: "create_goal", title: action.title!.trim(), ...(action.why ? { why: action.why } : {}), ...(action.targetDate ? { targetLocalDate: action.targetDate } : {}) });
          } else if (action.op === "update") {
            steps.push({
              kind: "update_goal", goalId: action.goalId!, expectedVersion: action.goalVersion!,
              patch: {
                ...(action.title !== null ? { title: action.title } : {}),
                ...(action.why !== null ? { why: action.why } : {}),
                ...(action.targetDate !== null ? { targetLocalDate: action.targetDate } : {}),
                ...(action.status !== null ? { status: action.status } : {}),
                ...(action.reviewEnabled !== null ? { reviewEnabled: action.reviewEnabled } : {}),
              },
            });
          } else if (action.op === "link") {
            steps.push({ kind: "link_task_to_goal", taskId: action.taskId!, expectedTaskVersion: action.taskVersion!, goalId: action.goalId!, expectedGoalVersion: action.goalVersion!, source: linkSource, confidence: action.intent === "explicit" ? 1 : 0.9 });
          } else {
            steps.push({ kind: "unlink_task_to_goal", taskId: action.taskId!, expectedTaskVersion: action.taskVersion!, goalId: action.goalId!, expectedGoalVersion: action.goalVersion! });
          }
          break;
        case "memory":
          if (action.op === "save") steps.push({ kind: "save_memory", memoryType: action.kind ?? "note", content: action.content!.trim(), sensitive: action.sensitive ?? false, source: linkSource });
          else if (action.op === "update") {
            steps.push({
              kind: "update_memory", memoryId: action.memoryId!, expectedVersion: action.memoryVersion!,
              patch: { ...(action.content !== null ? { content: action.content.trim() } : {}), ...(action.sensitive !== null ? { sensitive: action.sensitive } : {}) },
            });
          } else steps.push({ kind: "delete_memory", memoryId: action.memoryId!, expectedVersion: action.memoryVersion! });
          break;
        case "settings": {
          const current = await this.settings.get(scope.actorUserId);
          if (!current) throw new InvalidAiActionError("settings are stale or missing", "settings_stale");
          const { patch } = settingsPatchForAction(action, current, snoozeUntilFromAction(action, current.timezone));
          steps.push({ kind: "update_settings", expectedVersion: action.expectedVersion, patch, operation: action.operation });
          break;
        }
      }
    }
    return steps;
  }

  private async afterCommit(result: Awaited<ReturnType<ActionGroupRepository["apply"]>>, actions: readonly ResolvedAction[], scope: ActionScope, now: Date): Promise<void> {
    await this.tasks.enqueuePreparedTaskPlans(result.preparedPlans.map((plan) => ({ plan, result: { taskId: plan.task.id, occurrenceIds: [], deliveryIds: [], reminderSchedules: [] } })));
    for (const occurrenceId of result.reminderRebuildOccurrenceIds) {
      await this.reminders.rebuildOccurrence(scope.workspaceId, occurrenceId, now).catch((error) => console.error("reminder rebuild deferred", { occurrenceId, error: safeError(error) }));
    }
    const fuzzyTaskIds = new Set<string>([
      ...result.fuzzyRebuildTaskIds,
      ...result.steps.filter((step) => step.kind === "cancel_task" || step.kind === "complete_task" || step.kind === "concretise_task").map((step) => step.taskId),
    ]);
    for (const taskId of fuzzyTaskIds) {
      await this.reminders.rebuildFuzzyTask(scope.workspaceId, scope.recipientUserId, taskId, now).catch((error) => console.error("planning reminder rebuild deferred", { taskId, error: safeError(error) }));
    }
    for (const taskId of result.reconcileTaskIds) {
      await this.tasks.reconcileRecurringTask(scope.workspaceId, taskId, now).catch((error) => console.error("series reconciliation deferred", { taskId, error: safeError(error) }));
    }
    for (const step of result.steps) {
      if (step.kind !== "occurrence_interaction" || step.operation !== "seen") continue;
      await this.reminders.scheduleSeenFallback({ workspaceId: scope.workspaceId, userId: scope.recipientUserId, occurrenceId: step.occurrenceId, now })
        .catch((error) => console.error("seen fallback deferred", { occurrenceId: step.occurrenceId, error: safeError(error) }));
    }
    void actions;
  }

  /** The user-facing report is built from what the repositories stored, never from the model. */
  private async reportItems(steps: readonly ActionGroupStepResult[], scope: ActionScope, actions: readonly ResolvedAction[]): Promise<AppliedReportItem[]> {
    const items: AppliedReportItem[] = [];
    for (const step of steps) {
      switch (step.kind) {
        case "create_task": {
          const created = actions.find((action): action is ResolvedActionOf<"create_task"> => action.type === "create_task" && action.body.title.trim() === step.title);
          items.push({
            kind: "task_created", title: step.title, timezone: created?.timezone ?? "UTC",
            ...(created ? { importance: created.body.importance, recurring: Boolean(created.body.recurrence) } : {}),
            schedule: await this.occurrenceScheduleForTask(scope.workspaceId, step.taskId),
            fuzzyHorizonText: created?.body.when.mode === "fuzzy" ? created.body.when.horizonText : null,
            reminderAt: await this.nextReminderForTask(scope.workspaceId, step.taskId),
            goalTitle: step.goalTitle,
          });
          break;
        }
        case "goal_plan":
          items.push({ kind: "goal_plan", goalTitle: step.goalTitle, tasks: await Promise.all(step.taskIds.map(async (taskId, index) => ({
            kind: "task_created" as const, title: step.taskTitles[index] ?? "", timezone: actions.find((action) => action.type === "plan")?.timezone ?? "UTC",
            schedule: await this.occurrenceScheduleForTask(scope.workspaceId, taskId),
            reminderAt: await this.nextReminderForTask(scope.workspaceId, taskId),
          }))) });
          break;
        case "update_task":
          items.push({ kind: "task_updated", title: step.title, changes: step.changes });
          break;
        case "update_occurrence":
          items.push({ kind: "occurrence", title: step.title, operation: step.operation });
          break;
        case "occurrence_interaction":
          items.push({ kind: "occurrence", title: step.title, operation: step.operation === "seen" ? "seen" : "record_blocker", details: step.details });
          break;
        case "complete_task":
          items.push({ kind: "occurrence", title: step.title, operation: "done" });
          break;
        case "cancel_task":
          items.push({ kind: "occurrence", title: step.title, operation: "cancel" });
          break;
        case "reschedule_occurrence":
          items.push({ kind: "task_rescheduled", title: step.title, before: step.previousSchedule, after: step.occurrenceSchedule, reminderAt: await this.reminders.nextUserReminderAt(scope.workspaceId, step.occurrenceId).catch(() => null), reason: step.reason });
          break;
        case "concretise_task":
          items.push({ kind: "task_rescheduled", title: step.title, before: null, after: step.occurrenceSchedule, reminderAt: await this.reminders.nextUserReminderAt(scope.workspaceId, step.occurrenceId).catch(() => null), reason: step.reason, fromFuzzy: step.previousFuzzyHorizonText });
          break;
        case "change_reminder":
          items.push({ kind: "reminder", title: step.title, mode: step.mode, schedule: step.occurrenceSchedule, reminderAt: await this.reminders.nextUserReminderAt(scope.workspaceId, step.occurrenceId).catch(() => null) });
          break;
        case "change_series":
          items.push({ kind: "series", title: step.title, operation: step.operation });
          break;
        case "create_goal":
          items.push({ kind: "goal_created", title: step.title });
          break;
        case "update_goal":
          items.push({ kind: "goal_updated", title: step.title });
          break;
        case "link_task_to_goal":
          items.push({ kind: "goal_linked", taskTitle: step.taskTitle, goalTitle: step.goalTitle });
          break;
        case "unlink_task_to_goal":
          items.push({ kind: "goal_unlinked", taskTitle: step.taskTitle, goalTitle: step.goalTitle });
          break;
        case "save_memory":
          items.push({ kind: "memory", operation: "saved", content: step.content });
          break;
        case "update_memory":
          items.push({ kind: "memory", operation: "updated", content: step.content });
          break;
        case "delete_memory":
          items.push({ kind: "memory", operation: "deleted", content: step.content });
          break;
        case "update_settings":
          if (step.operation) items.push({ kind: "settings", operation: step.operation });
          break;
      }
    }
    return items;
  }

  private async occurrenceScheduleForTask(workspaceId: string, taskId: string) {
    const occurrence = await this.tasks.findCurrentOccurrence(workspaceId, taskId, {}).catch(() => null);
    if (!occurrence) return null;
    return {
      timezone: occurrence.timezone,
      plannedStartAt: occurrence.plannedStartAt ?? null,
      plannedEndAt: occurrence.plannedEndAt ?? null,
      plannedLocalDate: occurrence.plannedLocalDate ?? null,
      dueAt: occurrence.dueAt ?? null,
      dueLocalDate: occurrence.dueLocalDate ?? null,
    };
  }

  private async nextReminderForTask(workspaceId: string, taskId: string): Promise<Date | null> {
    const occurrence = await this.tasks.findCurrentOccurrence(workspaceId, taskId, {}).catch(() => null);
    if (!occurrence) return null;
    return this.reminders.nextUserReminderAt(workspaceId, occurrence.id).catch(() => null);
  }

  private async validateSettingsAction(action: ResolvedActionOf<"settings">, userId: string, now: Date): Promise<void> {
    const current = await this.settings.get(userId);
    if (!current || current.version !== action.expectedVersion) throw new InvalidAiActionError("settings are stale or missing", "settings_stale");
    if (action.operation === "timezone") {
      if (!action.timezone) throw new InvalidAiActionError("timezone is required", "settings_shape");
      if (action.applyTimezoneTo === null) throw new InvalidAiActionError("timezone scope is required", "settings_shape");
      new Intl.DateTimeFormat("en", { timeZone: action.timezone }).format(now);
      return;
    }
    if (action.operation === "language") {
      if (action.language !== null && !action.language.trim()) throw new InvalidAiActionError("language cannot be blank", "settings_shape");
      if (action.language !== null) normalizeLanguageTag(action.language);
      return;
    }
    if (action.operation === "digest") {
      if (action.digestKind === null || action.enabled === null) throw new InvalidAiActionError("digest kind and enabled state are required", "settings_shape");
      return;
    }
    if (action.operation === "weekly_review") {
      if (action.enabled === null) throw new InvalidAiActionError("weekly review enabled state is required", "settings_shape");
      if (action.enabled && (action.weekday === null || action.time === null)) throw new InvalidAiActionError("weekly review requires weekday and time", "settings_shape");
      return;
    }
    if (action.operation === "quiet_hours") {
      if (action.enabled === null) throw new InvalidAiActionError("quiet hours enabled state is required", "settings_shape");
      const times = [action.weekdayStart, action.weekdayEnd, action.weekendStart, action.weekendEnd];
      if (action.enabled && times.some((value) => value === null)) throw new InvalidAiActionError("enabled quiet hours require weekday and weekend ranges", "settings_shape");
      return;
    }
    if (action.operation === "snooze") {
      const until = snoozeUntilFromAction(action, current.timezone);
      if (until) {
        if (until <= now) throw new InvalidAiActionError("notification snooze must be in the future", "time_past");
        if (until.getTime() - now.getTime() > 7 * 24 * 60 * 60_000) throw new InvalidAiActionError("notification snooze cannot exceed 7 days", "settings_shape");
      }
      return;
    }
    const values = [action.eventOffsets, action.plannedTaskOffsetMinutes, action.criticalPostDueMinutes, action.seenNormalMinutes, action.seenRequiredMinutes, action.seenCriticalMinutes];
    if (values.every((value) => value === null)) throw new InvalidAiActionError("at least one reminder default is required", "settings_shape");
    if (action.eventOffsets !== null && action.eventOffsets.length === 0) throw new InvalidAiActionError("event offsets cannot be empty", "settings_shape");
    for (const value of [action.criticalPostDueMinutes, action.seenNormalMinutes, action.seenRequiredMinutes, action.seenCriticalMinutes]) {
      if (value !== null && value < 15) throw new InvalidAiActionError("critical and Seen intervals must be at least 15 minutes", "settings_shape");
    }
  }
}

function scheduleContext(action: ResolvedAction): ScheduleContext {
  return { timezone: action.timezone, reviewTime: action.reviewTime };
}

function snoozeUntilFromAction(action: ResolvedActionOf<"settings">, timezone: string): Date | null {
  if (action.operation !== "snooze" || !action.snoozeUntilDate) return null;
  return localDateAndTimeToUtc(action.snoozeUntilDate, action.snoozeUntilTime ?? "09:00", timezone).date;
}

function updateTaskPatchForRepository(action: ResolvedActionOf<"update_task">) {
  const patch = action.patch;
  const habit = patch.habit;
  return {
    ...(patch.title !== null ? { title: patch.title.trim() } : {}),
    ...(patch.why !== null ? { why: patch.why.trim() } : {}),
    ...(patch.nextAction !== null ? { nextAction: patch.nextAction.trim() } : {}),
    ...(patch.context !== null ? { context: patch.context.trim() } : {}),
    ...(patch.importance !== null ? { importance: patch.importance } : {}),
    ...(patch.checklist !== null ? { checklist: patch.checklist.map((item) => ({ text: item.text.trim(), done: item.done })) } : {}),
    ...(habit === null ? {} : "minimumAction" in habit
      ? { habitMode: true, minimumAction: habit.minimumAction, desiredAction: habit.desiredAction, habitTrigger: habit.trigger }
      : { habitMode: false, minimumAction: null, desiredAction: null, habitTrigger: null }),
  };
}

function taskStateStep(action: ResolvedActionOf<"set_task_state">): ActionGroupStep {
  const target: TaskTarget = action.target;
  if (action.state === "done") return { kind: "complete_task", taskId: target.taskId, expectedVersion: target.taskVersion };
  if (action.state === "cancelled") {
    if (target.kind === "series") return { kind: "change_series", taskId: target.taskId, expectedVersion: target.taskVersion, operation: "cancel" };
    if (target.kind === "occurrence") return { kind: "update_occurrence", occurrenceId: target.occurrenceId, expectedVersion: target.occurrenceVersion, operation: "cancel" };
    return { kind: "cancel_task", taskId: target.taskId, expectedVersion: target.taskVersion };
  }
  if (target.kind !== "occurrence") throw new InvalidAiActionError("a task without a date has no occurrence to change", "fuzzy_no_occurrence");
  if (action.state === "started") return { kind: "update_occurrence", occurrenceId: target.occurrenceId, expectedVersion: target.occurrenceVersion, operation: "start" };
  if (action.state === "skipped") return { kind: "update_occurrence", occurrenceId: target.occurrenceId, expectedVersion: target.occurrenceVersion, operation: "skip" };
  return action.note?.trim()
    ? { kind: "occurrence_interaction", occurrenceId: target.occurrenceId, expectedVersion: target.occurrenceVersion, operation: "record_blocker", details: action.note.trim() }
    : { kind: "occurrence_interaction", occurrenceId: target.occurrenceId, expectedVersion: target.occurrenceVersion, operation: "seen" };
}

function stepTitle(step: ActionGroupStepResult): string | null {
  if ("title" in step && typeof step.title === "string") return step.title;
  if (step.kind === "goal_plan") return step.goalTitle;
  if (step.kind === "link_task_to_goal" || step.kind === "unlink_task_to_goal") return step.taskTitle;
  if (step.kind === "save_memory" || step.kind === "update_memory" || step.kind === "delete_memory") return step.content;
  return null;
}

export { InvalidAiActionError };
export { describeAction } from "./action-describe.js";
