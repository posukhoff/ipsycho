import type { ResolvedAction, ResolvedActionOf } from "../core/ai-contract.js";
import { habitOfferEligible } from "../core/habit-policy.js";
import { normalizeLanguageTag } from "../core/language.js";
import { rescheduledDefinition, rescheduledOccurrenceStatus } from "../core/reschedule.js";
import { validateOneTimeTaskTiming } from "../core/task-policy.js";
import { localDateAndTimeToUtc } from "../core/timezone.js";
import { isTerminalOccurrenceStatus } from "../core/types.js";
import type { ContextService } from "../context/context.service.js";
import type { ReminderSchedulingService } from "../reminders/reminder-scheduling.service.js";
import type { SettingsService } from "../settings/settings.service.js";
import { taskDefinitionFromRow } from "../tasks/task-record-mappers.js";
import type { TasksService } from "../tasks/tasks.service.js";
import {
  createTaskInputFromBody,
  InvalidAiActionError,
  reminderRuleFromReminder,
  rescheduleFieldsFromWhen,
  seriesDefinitionFromReschedule,
  validateUpdateTaskPatch,
  type ScheduleContext,
} from "./action-conversion.js";

/** What validation is allowed to read. Narrower than the service, so a rule cannot start writing. */
export interface ValidationDeps {
  tasks: Pick<TasksService, "getTask" | "getOccurrenceContext" | "isRescheduleReasonRequired">;
  context: Pick<ContextService, "findGoal" | "findMemory">;
  reminders: Pick<ReminderSchedulingService, "validateExplicitReminderChange">;
  settings: Pick<SettingsService, "get">;
}

export interface ValidationScope {
  workspaceId: string;
  actorUserId: string;
  recipientUserId: string;
  now: Date;
}

function scheduleContext(action: ResolvedAction): ScheduleContext {
  return { timezone: action.timezone, reviewTime: action.reviewTime };
}

function snoozeUntilFromAction(action: ResolvedActionOf<"settings">, timezone: string): Date | null {
  if (action.operation !== "snooze" || !action.snoozeUntilDate) return null;
  return localDateAndTimeToUtc(action.snoozeUntilDate, action.snoozeUntilTime ?? "09:00", timezone).date;
}

/**
 * The domain rules that need the current stored state: a target still exists at the version the
 * model saw, a terminal occurrence is not reopened, a reminder is in the future, a habit is
 * eligible. Pure of persistence itself; every read goes through the services in `deps`.
 */
export async function validateResolvedAction(action: ResolvedAction, scope: ValidationScope, deps: ValidationDeps): Promise<void> {
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
      const task = await deps.tasks.getTask(scope.workspaceId, action.taskId);
      if (!task || task.version !== action.taskVersion) throw new InvalidAiActionError("target task is missing or stale", "stale");
      const enablesHabit = action.patch.habit !== null && "minimumAction" in action.patch.habit;
      if (enablesHabit) {
        if (!task.recurrenceRule) throw new InvalidAiActionError("habit mode requires a recurring task", "habit_not_eligible");
        if (task.habitMode) throw new InvalidAiActionError("task is already a habit", "habit_not_eligible");
        if (
          action.intent === "inferred" &&
          !habitOfferEligible({ recurring: true, kind: task.kind, alreadyHabit: task.habitMode, offeredBefore: Boolean(task.habitOfferSentAt), behavioral: true })
        ) {
          throw new InvalidAiActionError("habit mode is not eligible or was already offered for this task", "habit_not_eligible");
        }
      }
      return;
    }
    case "set_task_state": {
      if (action.target.kind === "occurrence") {
        const context = await deps.tasks.getOccurrenceContext(scope.workspaceId, action.target.occurrenceId);
        if (!context || context.occurrence.version !== action.target.occurrenceVersion) throw new InvalidAiActionError("target occurrence is missing or stale", "stale");
        if (action.state !== "done" && isTerminalOccurrenceStatus(context.occurrence.status)) {
          throw new InvalidAiActionError("terminal occurrence cannot be changed", "terminal_occurrence");
        }
      }
      if (action.state === "seen" && action.note !== null && !action.note.trim()) throw new InvalidAiActionError("blocker details are required", "blank_field");
      if (action.state !== "seen" && action.note !== null) throw new InvalidAiActionError("details are only valid when recording a blocker", "note_not_allowed");
      const task = await deps.tasks.getTask(scope.workspaceId, action.target.taskId);
      if (!task || task.version !== action.target.taskVersion) throw new InvalidAiActionError("target task is missing or stale", "stale");
      if (action.state === "done" && task.status !== "active") throw new InvalidAiActionError("only an active task can be marked done", "task_not_active");
      return;
    }
    case "reschedule": {
      const { fields, timeMode } = rescheduleFieldsFromWhen(action.when, ctx);
      if (action.target.kind === "series") {
        const task = await deps.tasks.getTask(scope.workspaceId, action.target.taskId);
        if (!task || task.version !== action.target.taskVersion) throw new InvalidAiActionError("series task is missing or stale", "stale");
        if (!task.recurrenceRule) throw new InvalidAiActionError("task is not a recurring series", "not_recurring");
        seriesDefinitionFromReschedule(action, taskDefinitionFromRow(task));
        return;
      }
      const task = await deps.tasks.getTask(scope.workspaceId, action.target.taskId);
      if (!task || task.version !== action.target.taskVersion) throw new InvalidAiActionError("target task is missing or stale", "stale");
      const next = rescheduledDefinition(taskDefinitionFromRow(task), fields, timeMode);
      const timingErrors = validateOneTimeTaskTiming(next, scope.now, "rescheduling a one-time task");
      if (timingErrors.length) throw new InvalidAiActionError(timingErrors.join("; "), "time_past");
      if (action.target.kind === "occurrence") {
        const context = await deps.tasks.getOccurrenceContext(scope.workspaceId, action.target.occurrenceId);
        if (!context || context.occurrence.version !== action.target.occurrenceVersion) throw new InvalidAiActionError("target occurrence is missing or stale", "stale");
        if (["done", "skipped", "cancelled"].includes(context.occurrence.status))
          throw new InvalidAiActionError("terminal occurrence cannot be rescheduled", "terminal_occurrence");
        if ((await deps.tasks.isRescheduleReasonRequired(scope.workspaceId, action.target.occurrenceId)) && !action.reason?.trim()) {
          throw new InvalidAiActionError("reschedule reason is required", "reason_required");
        }
      } else {
        rescheduledOccurrenceStatus(next, scope.now);
      }
      return;
    }
    case "set_reminder": {
      if (action.target.kind !== "occurrence") throw new InvalidAiActionError("a task without a date cannot carry a reminder", "fuzzy_reminder");
      const context = await deps.tasks.getOccurrenceContext(scope.workspaceId, action.target.occurrenceId);
      if (!context || context.occurrence.version !== action.target.occurrenceVersion) throw new InvalidAiActionError("target occurrence is missing or stale", "stale");
      const rule = action.reminder ? reminderRuleFromReminder(action.reminder, action.target.timezone) : undefined;
      if (rule?.exactAt && rule.exactAt <= scope.now) throw new InvalidAiActionError("reminder must be in the future", "time_past");
      await deps.reminders.validateExplicitReminderChange({
        workspaceId: scope.workspaceId,
        userId: scope.recipientUserId,
        occurrenceId: action.target.occurrenceId,
        mode: action.mode,
        ...(rule ? { rule } : {}),
        now: scope.now,
      });
      return;
    }
    case "goal": {
      if (action.op === "create") {
        if (!action.title?.trim()) throw new InvalidAiActionError("goal title is required", "goal_title");
        return;
      }
      const goal = await deps.context.findGoal(scope.workspaceId, action.goalId!);
      if (!goal || goal.version !== action.goalVersion) throw new InvalidAiActionError("target goal is missing or stale", "stale");
      if (action.op === "update") {
        if (action.title !== null && !action.title.trim()) throw new InvalidAiActionError("goal title cannot be blank", "blank_field");
        if (action.why !== null && !action.why.trim()) throw new InvalidAiActionError("goal why cannot be blank", "blank_field");
        return;
      }
      if (goal.status !== "active" && action.op === "link") throw new InvalidAiActionError("target goal is missing or stale", "stale");
      const task = await deps.tasks.getTask(scope.workspaceId, action.taskId!);
      if (!task || task.version !== action.taskVersion) throw new InvalidAiActionError("target task is missing or stale", "stale");
      return;
    }
    case "memory": {
      if (action.op === "save") {
        if (!action.content?.trim()) throw new InvalidAiActionError("memory content is required", "memory_shape");
        return;
      }
      const memory = await deps.context.findMemory(scope.workspaceId, scope.actorUserId, action.memoryId!);
      if (!memory || memory.version !== action.memoryVersion) throw new InvalidAiActionError("memory is missing or stale", "stale");
      return;
    }
    case "settings":
      await validateSettingsAction(action, scope.actorUserId, scope.now, deps);
      return;
  }
}

async function validateSettingsAction(action: ResolvedActionOf<"settings">, userId: string, now: Date, deps: ValidationDeps): Promise<void> {
  const current = await deps.settings.get(userId);
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
  const values = [
    action.eventOffsets,
    action.plannedTaskOffsetMinutes,
    action.criticalPostDueMinutes,
    action.seenNormalMinutes,
    action.seenRequiredMinutes,
    action.seenCriticalMinutes,
  ];
  if (values.every((value) => value === null)) throw new InvalidAiActionError("at least one reminder default is required", "settings_shape");
  if (action.eventOffsets !== null && action.eventOffsets.length === 0) throw new InvalidAiActionError("event offsets cannot be empty", "settings_shape");
  for (const value of [action.criticalPostDueMinutes, action.seenNormalMinutes, action.seenRequiredMinutes, action.seenCriticalMinutes]) {
    if (value !== null && value < 15) throw new InvalidAiActionError("critical and Seen intervals must be at least 15 minutes", "settings_shape");
  }
}
