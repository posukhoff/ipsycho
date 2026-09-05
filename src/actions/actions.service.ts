import { randomUUID } from "node:crypto";
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { ResolvedActionSchema, type AiAction, type ResolvedAction, type ResolvedActionOf, type TaskTarget } from "../core/ai-contract.js";
import { AI_ACTION_TYPES } from "../core/ai-contract.js";
import { ACTION_CONFIRMATION_TTL_MS, ACTION_UNDO_TTL_MS, actionExpiry } from "../core/action-lifecycle.js";
import { groupDisposition, type ActionIssue } from "../core/ai-actions.js";
import type { RefMap } from "../core/ai-refs.js";
import { rescheduledDefinition, rescheduledOccurrenceStatus } from "../core/reschedule.js";
import { localDateAndTimeToUtc } from "../core/timezone.js";
import type { AppliedReportItem } from "../core/applied-report.js";
import { ContextService } from "../context/context.service.js";
import { taskDefinitionFromRow } from "../tasks/task-record-mappers.js";
import { TasksService } from "../tasks/tasks.service.js";
import { ReminderSchedulingService } from "../reminders/reminder-scheduling.service.js";
import { safeError } from "../observability/safe-error.js";
import { SettingsService } from "../settings/settings.service.js";
import {
  createTaskInputFromBody,
  InvalidAiActionError,
  reminderRuleFromReminder,
  rescheduleFieldsFromWhen,
  seriesDefinitionFromReschedule,
  type ScheduleContext,
} from "./action-conversion.js";
import { describeAction, settingsPatchForAction, type ActionNames } from "./action-describe.js";
import { validateResolvedAction, type ValidationDeps } from "./action-validation.js";
import { buildAppliedReport, type ReportDeps } from "./applied-report.builder.js";
import { resolveActions } from "./action-resolver.js";
import { ActionGroupRepository, type ActionGroupStep, type ActionGroupStepResult } from "./action-group.repository.js";
import { ActionsRepository } from "./actions.repository.js";
import { DomainRuleError } from "../core/errors.js";
import { isConnectionLevelError } from "../database/pg-errors.js";
import { foldNewTaskRefs } from "../core/new-task-refs.js";
import { interfaceLocale } from "../core/language.js";
import { logger } from "../observability/logger.js";

export interface ActionScope {
  workspaceId: string;
  actorUserId: string;
  recipientUserId: string;
  sourceMessageId?: string;
  now?: Date;
  /** Interface language of the acting user; card titles are worded in it. */
  language?: string | null;
}

export interface ProposedActionsResult {
  applied?: {
    groupId: string;
    /** False for interaction-only actions such as Seen that have no reversible state transition. */
    count: number;
    titles: string[];
    /** Persisted facts for the user-facing applied report. */
    items?: AppliedReportItem[];
  };
  pending?: { groupId: string; count: number; titles: string[] };
  warnings?: string[];
}

export interface PendingGroupSummary {
  groupId: string;
  createdAt: Date;
  titles: string[];
  actions: ResolvedAction[];
}

/**
 * The connection to PostgreSQL broke while the group's transaction was in flight. The commit
 * may or may not have landed; the group stays in `applying` and boot recovery reconciles it.
 * The user is told not to repeat the command rather than being retried into a duplicate.
 */
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
    private readonly groups: ActionGroupRepository,
    private readonly tasks: TasksService,
    private readonly reminders: ReminderSchedulingService,
    private readonly context: ContextService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Short ids and versions become server-resolved actions, then every domain rule runs.
   * Issues are returned, never thrown: the chat layer answers them deterministically.
   */
  async prepare(actions: readonly AiAction[], refs: RefMap, scope: Omit<ActionScope, "sourceMessageId">): Promise<{ resolved: ResolvedAction[]; issues: ActionIssue[] }> {
    const now = scope.now ?? new Date();
    const folded = foldNewTaskRefs(actions);
    const { resolved, issues: resolveIssues } = await resolveActions(
      folded.actions,
      refs,
      {
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
      },
      now,
    );
    const domainIssues = await this.validate(resolved, { ...scope, now });
    const reindex = (issue: ActionIssue): ActionIssue => ({ ...issue, index: folded.originalIndex[issue.index] ?? issue.index });
    return { resolved, issues: [...folded.issues, ...resolveIssues.map(reindex), ...domainIssues.map(reindex)] };
  }

  /** The same domain validation `prepare` runs, for callers that build a resolved action themselves (settings commands). */
  validateResolved(actions: readonly ResolvedAction[], scope: Omit<ActionScope, "sourceMessageId">): Promise<ActionIssue[]> {
    return this.validate(actions, { ...scope, now: scope.now ?? new Date() });
  }

  /** The narrow read-only views the validation and report modules are given. */
  private validationDeps(): ValidationDeps {
    return { tasks: this.tasks, context: this.context, reminders: this.reminders, settings: this.settings };
  }

  private reportDeps(): ReportDeps {
    return { tasks: this.tasks, reminders: this.reminders };
  }

  /** Domain rules that need the current stored state; one issue per action index. */
  async validate(actions: readonly ResolvedAction[], scope: Omit<ActionScope, "sourceMessageId">): Promise<ActionIssue[]> {
    const now = scope.now ?? new Date();
    // Validation only reads; the actions of one package are checked concurrently.
    const results = await Promise.allSettled(actions.map((action) => validateResolvedAction(action, { ...scope, now }, this.validationDeps())));
    const issues: ActionIssue[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const error: unknown = result.reason;
      const code = error instanceof InvalidAiActionError ? error.code : "invalid_action";
      const message = error instanceof Error ? error.message : "invalid action";
      issues.push({ kind: /stale|missing/i.test(message) ? "reference" : "domain", index, code, message });
    });
    return issues;
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
  async applyResolved(
    actions: readonly ResolvedAction[],
    scope: ActionScope,
    groupId: string = randomUUID(),
    groupExists = false,
  ): Promise<NonNullable<ProposedActionsResult["applied"]>> {
    const now = scope.now ?? new Date();
    const steps = await this.prepareSteps(actions, { ...scope, now }, groupId);
    let result;
    try {
      result = await this.groups.apply({
        workspaceId: scope.workspaceId,
        actorUserId: scope.actorUserId,
        groupId,
        groupExists,
        ...(scope.sourceMessageId ? { sourceMessageId: scope.sourceMessageId } : {}),
        steps,
        now,
        undoExpiresAt: actionExpiry(now, ACTION_UNDO_TTL_MS),
      });
    } catch (error) {
      if (isConnectionLevelError(error)) throw new ActionStateUncertainError(groupId);
      if (groupExists) await this.repository.markFailed(scope.workspaceId, groupId).catch(() => undefined);
      throw error;
    }
    await this.afterCommit(result, actions, scope, now);
    const items = await buildAppliedReport(result.steps, scope, actions, this.reportDeps());
    return {
      groupId,
      count: actions.length,
      titles: result.steps.map(stepTitle).filter((title): title is string => Boolean(title)),
      items,
    };
  }

  /** Deterministic series buttons (pause/cancel) bypass the model but share the journal. */
  async applySeriesOperation(scope: ActionScope, taskId: string, expectedVersion: number, operation: "pause" | "resume" | "stop" | "cancel"): Promise<ProposedActionsResult> {
    const now = scope.now ?? new Date();
    const groupId = randomUUID();
    const result = await this.groups.apply({
      workspaceId: scope.workspaceId,
      actorUserId: scope.actorUserId,
      groupId,
      groupExists: false,
      steps: [{ kind: "change_series", taskId, expectedVersion, operation }],
      now,
      undoExpiresAt: actionExpiry(now, ACTION_UNDO_TTL_MS),
    });
    for (const id of result.reconcileTaskIds)
      await this.tasks.reconcileRecurringTask(scope.workspaceId, id, now).catch((error) => logger.error("series reconciliation deferred", { taskId: id, error: safeError(error) }));
    const items = await buildAppliedReport(result.steps, scope, [], this.reportDeps());
    return { applied: { groupId, count: 1, titles: result.steps.map(stepTitle).filter((title): title is string => Boolean(title)), items } };
  }

  async confirm(workspaceId: string, actorUserId: string, recipientUserId: string, groupId: string, now = new Date()): Promise<NonNullable<ProposedActionsResult["applied"]>> {
    const claimed = await this.repository.claimPendingGroup(workspaceId, actorUserId, groupId, now);
    if (!claimed) throw new DomainRuleError("confirmation expired or already handled");
    let actions: ResolvedAction[];
    try {
      actions = claimed.actions.map((row) => ResolvedActionSchema.parse(row.payload) as ResolvedAction);
    } catch (error) {
      await this.repository.markFailed(workspaceId, groupId).catch(() => undefined);
      throw error;
    }
    const scope: ActionScope = {
      workspaceId,
      actorUserId,
      recipientUserId,
      now,
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
  async pendingGroupSummary(workspaceId: string, actorUserId: string, groupId: string, now = new Date(), language?: string | null): Promise<PendingGroupSummary | null> {
    const group = await this.repository.findPendingGroup(workspaceId, actorUserId, groupId, now);
    if (!group) return null;
    const actions: ResolvedAction[] = [];
    for (const row of group.actions) {
      const parsed = ResolvedActionSchema.safeParse(row.payload);
      if (parsed.success) actions.push(parsed.data as ResolvedAction);
    }
    const locale = interfaceLocale(language);
    const names = await this.actionNames(workspaceId, actorUserId, actions);
    const titles = group.actions.map((row) => {
      const parsed = ResolvedActionSchema.safeParse(row.payload);
      return parsed.success ? describeAction(parsed.data as ResolvedAction, locale, names) : row.actionType;
    });
    return { groupId: group.groupId, createdAt: group.createdAt, titles, actions };
  }

  async undo(workspaceId: string, actorUserId: string, groupId: string, now = new Date()): Promise<void> {
    const claimed = await this.repository.claimUndo(workspaceId, actorUserId, groupId, now);
    if (!claimed) throw new DomainRuleError("undo expired or action already changed");
    let result;
    try {
      result = await this.groups.undo({ workspaceId, groupId, now });
    } catch (error) {
      await this.repository.releaseUndoClaim(workspaceId, groupId).catch(() => undefined);
      throw error;
    }
    for (const occurrenceId of result.reminderRebuildOccurrenceIds) {
      await this.reminders
        .rebuildOccurrence(workspaceId, occurrenceId)
        .catch((error) => logger.error("reminder rebuild deferred after undo", { occurrenceId, error: safeError(error) }));
    }
    for (const taskId of result.fuzzyRebuildTaskIds) {
      await this.reminders
        .rebuildFuzzyTask(workspaceId, actorUserId, taskId, now)
        .catch((error) => logger.error("planning reminder rebuild deferred after undo", { taskId, error: safeError(error) }));
    }
    for (const taskId of result.reconcileTaskIds) {
      await this.tasks
        .reconcileRecurringTask(workspaceId, taskId, now)
        .catch((error) => logger.error("series reconciliation deferred after undo", { taskId, error: safeError(error) }));
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
    await this.repository
      .expireLegacyPendingGroups(new Date(), (actionType, payload) => KNOWN_ACTION_TYPES.has(actionType) && ResolvedActionSchema.safeParse(payload).success)
      .catch((error) => logger.error("legacy pending action expiry failed", { error: safeError(error) }));
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
        logger.error("action recovery failed", { groupId: group.id, status: group.status, error: safeError(error) });
      }
    }
    await this.repository.expirePendingGroups(now).catch((error) => logger.error("pending action cleanup failed", { error: safeError(error) }));
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
    const locale = interfaceLocale(scope.language);
    const names = await this.actionNames(scope.workspaceId, scope.actorUserId, actions);
    return { groupId, count: actions.length, titles: actions.map((action) => describeAction(action, locale, names)) };
  }

  /** Titles of the tasks, goals and notes a package addresses, so a card says «Отменить «Созвон»», not «Отменить». */
  private async actionNames(workspaceId: string, userId: string, actions: readonly ResolvedAction[]): Promise<ActionNames> {
    const taskIds = new Set<string>();
    const goalIds = new Set<string>();
    const memoryIds = new Set<string>();
    for (const action of actions) {
      if (action.type === "update_task") taskIds.add(action.taskId);
      if (action.type === "set_task_state" || action.type === "reschedule" || action.type === "set_reminder") taskIds.add(action.target.taskId);
      if (action.type === "goal") {
        if (action.taskId) taskIds.add(action.taskId);
        if (action.goalId) goalIds.add(action.goalId);
      }
      if (action.type === "memory" && action.memoryId) memoryIds.add(action.memoryId);
    }
    const [tasks, goals, memory] = await Promise.all([
      Promise.all([...taskIds].map(async (id) => [id, (await this.tasks.getTask(workspaceId, id).catch(() => null))?.title] as const)),
      Promise.all([...goalIds].map(async (id) => [id, (await this.context.findGoal(workspaceId, id).catch(() => null))?.title] as const)),
      Promise.all([...memoryIds].map(async (id) => [id, (await this.context.findMemory(workspaceId, userId, id).catch(() => null))?.content] as const)),
    ]);
    const map = (entries: ReadonlyArray<readonly [string, string | undefined]>) =>
      new Map(entries.filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"));
    return { tasks: map(tasks), goals: map(goals), memory: map(memory) };
  }

  /** Pure-ish compilation outside the transaction: task plans and definitions are built first. */
  private async prepareSteps(actions: readonly ResolvedAction[], scope: Required<Pick<ActionScope, "now">> & ActionScope, groupId: string): Promise<ActionGroupStep[]> {
    const steps: ActionGroupStep[] = [];
    for (const action of actions) {
      const ctx = scheduleContext(action);
      const linkSource = action.intent === "explicit" ? ("user_explicit" as const) : ("ai_inferred" as const);
      switch (action.type) {
        case "create_task": {
          const [built] = await this.tasks.prepareTaskPlans([createTaskInputFromBody(action.body, { ...scope, sourceActionGroupId: groupId, now: scope.now }, ctx)]);
          if (!built) throw new InvalidAiActionError("task plan could not be prepared", "invalid_action");
          steps.push({
            kind: "create_task",
            plan: built.plan,
            goalLink: action.goal
              ? { goalId: action.goal.goalId, goalVersion: action.goal.goalVersion, source: linkSource, confidence: action.intent === "explicit" ? 1 : 0.9 }
              : null,
          });
          break;
        }
        case "plan": {
          const built = await this.tasks.prepareTaskPlans(
            action.tasks.map((task) => createTaskInputFromBody(task, { ...scope, sourceActionGroupId: groupId, now: scope.now }, ctx)),
          );
          steps.push({
            kind: "goal_plan",
            goal: {
              title: action.goal.title,
              ...(action.goal.why ? { why: action.goal.why } : {}),
              ...(action.goal.targetDate ? { targetLocalDate: action.goal.targetDate } : {}),
            },
            plans: built.map((item) => item.plan),
            source: linkSource,
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
            steps.push({
              kind: "change_series",
              taskId: action.target.taskId,
              expectedVersion: action.target.taskVersion,
              operation: "edit",
              editDefinition: seriesDefinitionFromReschedule(action, taskDefinitionFromRow(task)),
            });
            break;
          }
          if (action.target.kind === "occurrence") {
            steps.push({
              kind: "reschedule_occurrence",
              occurrenceId: action.target.occurrenceId,
              expectedVersion: action.target.occurrenceVersion,
              scheduleTimezone: action.target.timezone,
              schedule: fields,
              timeMode,
              ...(action.reason ? { reason: action.reason } : {}),
            });
            break;
          }
          // A task with no occurrence becomes concrete: the first occurrence and its default
          // reminders are created in the same transaction as the schedule change.
          const task = await this.tasks.getTask(scope.workspaceId, action.target.taskId);
          if (!task) throw new InvalidAiActionError("target task is missing or stale", "stale");
          const definition = rescheduledDefinition(taskDefinitionFromRow(task), fields, timeMode);
          steps.push({
            kind: "concretise_task",
            taskId: action.target.taskId,
            expectedVersion: action.target.taskVersion,
            definition,
            occurrenceStatus: rescheduledOccurrenceStatus(definition, scope.now),
            ...(action.reason ? { reason: action.reason } : {}),
          });
          break;
        }
        case "set_reminder": {
          if (action.target.kind !== "occurrence") throw new InvalidAiActionError("a task without a date cannot carry a reminder", "fuzzy_reminder");
          steps.push({
            kind: "change_reminder",
            occurrenceId: action.target.occurrenceId,
            expectedVersion: action.target.occurrenceVersion,
            mode: action.mode,
            ...(action.reminder ? { rule: reminderRuleFromReminder(action.reminder, action.target.timezone) } : {}),
          });
          break;
        }
        case "goal":
          if (action.op === "create") {
            steps.push({
              kind: "create_goal",
              title: action.title!.trim(),
              ...(action.why ? { why: action.why } : {}),
              ...(action.targetDate ? { targetLocalDate: action.targetDate } : {}),
            });
          } else if (action.op === "update") {
            steps.push({
              kind: "update_goal",
              goalId: action.goalId!,
              expectedVersion: action.goalVersion!,
              patch: {
                ...(action.title !== null ? { title: action.title } : {}),
                ...(action.why !== null ? { why: action.why } : {}),
                ...(action.targetDate !== null ? { targetLocalDate: action.targetDate } : {}),
                ...(action.status !== null ? { status: action.status } : {}),
                ...(action.reviewEnabled !== null ? { reviewEnabled: action.reviewEnabled } : {}),
              },
            });
          } else if (action.op === "link") {
            steps.push({
              kind: "link_task_to_goal",
              taskId: action.taskId!,
              expectedTaskVersion: action.taskVersion!,
              goalId: action.goalId!,
              expectedGoalVersion: action.goalVersion!,
              source: linkSource,
              confidence: action.intent === "explicit" ? 1 : 0.9,
            });
          } else {
            steps.push({
              kind: "unlink_task_to_goal",
              taskId: action.taskId!,
              expectedTaskVersion: action.taskVersion!,
              goalId: action.goalId!,
              expectedGoalVersion: action.goalVersion!,
            });
          }
          break;
        case "memory":
          if (action.op === "save")
            steps.push({ kind: "save_memory", memoryType: action.kind ?? "note", content: action.content!.trim(), sensitive: action.sensitive ?? false, source: linkSource });
          else if (action.op === "update") {
            steps.push({
              kind: "update_memory",
              memoryId: action.memoryId!,
              expectedVersion: action.memoryVersion!,
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
    await this.tasks.enqueuePreparedTaskPlans(
      result.preparedPlans.map((plan) => ({ plan, result: { taskId: plan.task.id, occurrenceIds: [], deliveryIds: [], reminderSchedules: [] } })),
    );
    // Each rebuild is its own transaction on its own rows; within a category they run together.
    // Categories stay ordered because a series reconciliation may create the occurrences a
    // later fuzzy rebuild reads.
    await Promise.all(
      [...new Set(result.reminderRebuildOccurrenceIds)].map((occurrenceId) =>
        this.reminders
          .rebuildOccurrence(scope.workspaceId, occurrenceId, now)
          .catch((error) => logger.error("reminder rebuild deferred", { occurrenceId, error: safeError(error) })),
      ),
    );
    const fuzzyTaskIds = new Set<string>([
      ...result.fuzzyRebuildTaskIds,
      ...result.steps.filter((step) => step.kind === "cancel_task" || step.kind === "complete_task" || step.kind === "concretise_task").map((step) => step.taskId),
    ]);
    await Promise.all(
      [...fuzzyTaskIds].map((taskId) =>
        this.reminders
          .rebuildFuzzyTask(scope.workspaceId, scope.recipientUserId, taskId, now)
          .catch((error) => logger.error("planning reminder rebuild deferred", { taskId, error: safeError(error) })),
      ),
    );
    await Promise.all(
      [...new Set(result.reconcileTaskIds)].map((taskId) =>
        this.tasks.reconcileRecurringTask(scope.workspaceId, taskId, now).catch((error) => logger.error("series reconciliation deferred", { taskId, error: safeError(error) })),
      ),
    );
    void actions;
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
  const cleared = new Set(patch.clear ?? []);
  return {
    ...(cleared.has("why") ? { why: null } : {}),
    ...(cleared.has("nextAction") ? { nextAction: null } : {}),
    ...(cleared.has("context") ? { context: null } : {}),
    ...(cleared.has("checklist") ? { checklist: [] } : {}),
    ...(patch.title !== null ? { title: patch.title.trim() } : {}),
    ...(patch.why !== null ? { why: patch.why.trim() } : {}),
    ...(patch.nextAction !== null ? { nextAction: patch.nextAction.trim() } : {}),
    ...(patch.context !== null ? { context: patch.context.trim() } : {}),
    ...(patch.importance !== null ? { importance: patch.importance } : {}),
    ...(patch.checklist !== null ? { checklist: patch.checklist.map((item) => ({ text: item.text.trim(), done: item.done })) } : {}),
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
  return { kind: "update_occurrence", occurrenceId: target.occurrenceId, expectedVersion: target.occurrenceVersion, operation: "skip" };
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
