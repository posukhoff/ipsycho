import { compileStructuredLocalSchedule, type CompiledLocalSchedule, type StructuredLocalScheduleInput } from "../core/local-schedule.js";
import { compileStructuredRecurrence } from "../core/recurrence-input.js";
import { recurrenceAnchorLocalDate, recurrenceAnchorLocalTime } from "../core/recurrence.js";
import { validateNewTaskTiming, validateTaskDefinition } from "../core/task-policy.js";
import { localDateAndTimeToUtc, localDateAt, localDateTimeAt } from "../core/timezone.js";
import type { Recurrence, Reminder, ResolvedActionOf, TaskBody, UpdateTaskPatch, When } from "../core/ai-contract.js";
import type { ReminderRuleSpec } from "../core/reminder-planning.js";
import type { RescheduleFields } from "../core/reschedule.js";
import type { MissPolicy, TaskDefinition, TimeMode } from "../core/types.js";
import type { CreateTaskInput } from "../tasks/tasks.service.js";

/** A domain rule the model's action violated. `code` keys the user-facing explanation. */
export class InvalidAiActionError extends Error {
  constructor(
    message: string,
    readonly code: string = "invalid_action",
  ) {
    super(message);
  }
}

export interface ScheduleContext {
  timezone: string;
  /** Local clock time used for a fuzzy planning checkpoint (the user's morning reference). */
  reviewTime: string;
}

export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
  } catch {
    throw new InvalidAiActionError("timezone is not a valid IANA timezone", "timezone");
  }
}

/** The model's `When` expressed as the structured schedule the domain compiler understands. */
export function structuredScheduleFromWhen(when: When, ctx: ScheduleContext): StructuredLocalScheduleInput {
  const base = {
    timezone: ctx.timezone,
    startDate: null,
    startTime: null,
    endDate: null,
    endTime: null,
    dueDate: null,
    dueTime: null,
    durationMinutes: null,
    fuzzyHorizonText: null,
    reviewDate: null,
    reviewTime: null,
  };
  switch (when.mode) {
    case "exact":
      return when.durationMinutes
        ? { ...base, mode: "window", startDate: when.date, startTime: when.time, durationMinutes: when.durationMinutes }
        : { ...base, mode: "exact", startDate: when.date, startTime: when.time };
    case "date":
      return { ...base, mode: "window", startDate: when.date };
    case "deadline":
      return { ...base, mode: "deadline", dueDate: when.date, dueTime: when.time };
    case "fuzzy":
      return { ...base, mode: "fuzzy", fuzzyHorizonText: when.horizonText, reviewDate: when.reviewDate, reviewTime: ctx.reviewTime };
  }
}

export function compileWhen(when: When, ctx: ScheduleContext): CompiledLocalSchedule {
  assertTimezone(ctx.timezone);
  try {
    return compileStructuredLocalSchedule(structuredScheduleFromWhen(when, ctx));
  } catch (error) {
    throw new InvalidAiActionError(error instanceof Error ? error.message : "invalid schedule", "schedule");
  }
}

function missPolicyDefault(timeMode: TimeMode): MissPolicy {
  return timeMode === "deadline" ? "carry_over" : "expire";
}

/** Recurrence fields for a definition whose one-time schedule is already compiled. */
function recurrenceFields(
  recurrence: Recurrence,
  schedule: CompiledLocalSchedule,
  timezone: string,
): Pick<TaskDefinition, "recurrenceRule" | "recurrenceTimezone" | "recurrenceEndLocalDate" | "recurrenceExcludedLocalDates"> {
  if (schedule.timeMode === "fuzzy") throw new InvalidAiActionError("recurring item cannot use fuzzy time", "recurring_fuzzy");
  const anchorTask = { ...schedule, kind: "task", importance: "normal" } as TaskDefinition;
  let compiled;
  try {
    compiled = compileStructuredRecurrence(
      {
        frequency: recurrence.frequency,
        interval: recurrence.interval,
        startsOn: recurrenceAnchorLocalDate(anchorTask, timezone),
        endsOn: recurrence.until,
        weekdays: recurrence.weekdays,
        monthDays: recurrence.monthDays,
        localTimes: null,
        excludedLocalDates: recurrence.skipDates,
      },
      { anchorLocalTime: recurrenceAnchorLocalTime(anchorTask, timezone) },
    );
  } catch (error) {
    throw new InvalidAiActionError(error instanceof Error ? error.message : "invalid recurrence", "recurrence");
  }
  return {
    recurrenceRule: compiled.recurrenceRule,
    recurrenceTimezone: timezone,
    ...(compiled.recurrenceEndLocalDate ? { recurrenceEndLocalDate: compiled.recurrenceEndLocalDate } : {}),
    ...(compiled.recurrenceExcludedLocalDates.length ? { recurrenceExcludedLocalDates: compiled.recurrenceExcludedLocalDates } : {}),
  };
}

export function taskDefinitionFromBody(body: TaskBody, ctx: ScheduleContext, now: Date): TaskDefinition {
  const schedule = compileWhen(body.when, ctx);
  const { timeMode, timezone, ...timing } = schedule;
  const recurring = body.recurrence ? recurrenceFields(body.recurrence, schedule, timezone) : {};
  // «Событие» means something that happens at a set time. When the model labels a deadline or a
  // bare day as an event, the label is the wrong half, not the time the user gave: the task keeps
  // the time and loses the label, instead of the whole package being refused.
  const kind = body.kind === "event" && timeMode !== "point" && timeMode !== "window" ? ("task" as const) : body.kind;
  const definition: TaskDefinition = {
    kind,
    importance: body.importance,
    timeMode,
    timezone,
    ...timing,
    ...recurring,
    ...(body.recurrence && kind === "task" ? { missPolicy: body.recurrence.missed ?? missPolicyDefault(timeMode) } : {}),
    habitMode: Boolean(body.habit),
    ...(body.habit
      ? { minimumAction: body.habit.minimumAction, desiredAction: body.habit.desiredAction, ...(body.habit.trigger ? { habitTrigger: body.habit.trigger } : {}) }
      : {}),
  };
  const validation = validateTaskDefinition(definition);
  if (!validation.ok) throw new InvalidAiActionError(validation.errors.join("; "), "task_definition");
  const timingErrors = validateNewTaskTiming(definition, now);
  if (timingErrors.length) throw new InvalidAiActionError(timingErrors.join("; "), "time_past");
  return definition;
}

export function createTaskInputFromBody(
  body: TaskBody,
  scope: {
    workspaceId: string;
    actorUserId: string;
    recipientUserId: string;
    sourceActionGroupId?: string;
    now: Date;
  },
  ctx: ScheduleContext,
): CreateTaskInput {
  const definition = taskDefinitionFromBody(body, ctx, scope.now);
  const explicitReminder = body.reminder ? explicitReminderForNewTask(body.reminder, definition, ctx.reviewTime) : undefined;
  return {
    workspaceId: scope.workspaceId,
    actorUserId: scope.actorUserId,
    recipientUserId: scope.recipientUserId,
    ...(scope.sourceActionGroupId ? { sourceActionGroupId: scope.sourceActionGroupId } : {}),
    title: body.title.trim(),
    definition,
    ...(body.why?.trim() ? { why: body.why.trim() } : {}),
    ...(body.nextAction?.trim() ? { nextAction: body.nextAction.trim() } : {}),
    ...(body.context?.trim() ? { context: body.context.trim() } : {}),
    ...(body.checklist?.length ? { checklist: body.checklist.map((item) => ({ text: item.text.trim(), done: item.done })) } : {}),
    ...(explicitReminder ? { explicitReminder } : {}),
    now: scope.now,
  };
}

/**
 * A reminder on a new task must be satisfiable by that task's own schedule:
 * otherwise the model could "promise" a reminder that never fires.
 */
function explicitReminderForNewTask(reminder: Reminder, definition: TaskDefinition, morningReferenceTime: string): ReminderRuleSpec {
  if (definition.timeMode === "fuzzy") throw new InvalidAiActionError("a task without a date cannot carry a reminder", "fuzzy_reminder");
  const rule = reminderRuleFromReminder(reminder, definition.timezone);
  if (rule.triggerKind === "relative_timestamp") {
    const anchorAt =
      rule.anchor === "planned_start"
        ? definition.plannedStartAt
        : rule.anchor === "planned_end"
          ? definition.plannedEndAt
          : rule.anchor === "due_at"
            ? definition.dueAt
            : undefined;
    if (!anchorAt) {
      // A day without a clock time has nothing to count minutes from. The user did ask to be
      // reminded, so the reminder becomes a morning one on that day instead of the whole package
      // failing over the shape of one field.
      const anchorDate = rule.anchor === "due_at" ? (definition.dueLocalDate ?? null) : (definition.plannedLocalDate ?? null);
      if (!anchorDate) throw new InvalidAiActionError(`reminder anchor ${rule.anchor} has no exact time on this task`, "date_only_offset");
      return {
        triggerKind: "local_date",
        anchor: rule.anchor === "due_at" ? "due_at" : "planned_start",
        daysOffset: 0,
        localTime: morningReferenceTime,
        purpose: "user_reminder",
        quietPolicy: rule.quietPolicy,
        origin: "explicit",
      };
    }
  }
  if (rule.triggerKind === "local_date") {
    const dueAnchor = definition.dueLocalDate ?? definition.dueAt;
    const startAnchor = definition.plannedLocalDate ?? definition.plannedStartAt;
    const anchorDate = rule.anchor === "due_at" ? dueAnchor : startAnchor;
    if (!anchorDate) {
      // The task has a day, just not the one the reminder names. Anchoring to the day it does have
      // is what the user asked for; refusing would drop the task along with the reminder.
      const fallback = rule.anchor === "due_at" ? startAnchor : dueAnchor;
      if (!fallback) throw new InvalidAiActionError(`reminder anchor ${rule.anchor} has no date on this task`, "reminder_anchor");
      return { ...rule, anchor: rule.anchor === "due_at" ? "planned_start" : "due_at" };
    }
  }
  return rule;
}

export function reminderRuleFromReminder(reminder: Reminder, timezone: string): ReminderRuleSpec {
  const common = { purpose: "user_reminder" as const, quietPolicy: reminder.quiet, origin: "explicit" as const };
  if (reminder.kind === "at") {
    return { triggerKind: "exact", exactAt: localDateAndTimeToUtc(reminder.date, reminder.time, timezone).date, ...common };
  }
  if (reminder.kind === "offset") {
    const anchor = reminder.anchor === "start" ? "planned_start" : reminder.anchor === "end" ? "planned_end" : "due_at";
    return { triggerKind: "relative_timestamp", anchor, offsetSeconds: reminder.minutes * 60, ...common };
  }
  return {
    triggerKind: "local_date",
    anchor: reminder.anchor === "start" ? "planned_start" : "due_at",
    daysOffset: reminder.daysOffset,
    localTime: reminder.time,
    ...common,
  };
}

/** An update that names no field changes nothing; it is not a mistake worth failing a package for. */
export function isNoOpUpdatePatch(patch: UpdateTaskPatch): boolean {
  return (
    patch.title === null &&
    patch.why === null &&
    patch.nextAction === null &&
    patch.context === null &&
    patch.importance === null &&
    patch.checklist === null &&
    patch.habit === null
  );
}

export function validateUpdateTaskPatch(patch: UpdateTaskPatch): void {
  if (isNoOpUpdatePatch(patch)) {
    throw new InvalidAiActionError("update_task patch must change at least one field", "empty_patch");
  }
  if (patch.title !== null && !patch.title.trim()) throw new InvalidAiActionError("task title cannot be empty", "blank_field");
  if (patch.why !== null && !patch.why.trim()) throw new InvalidAiActionError("why cannot be blank; use no update instead", "blank_field");
  if (patch.nextAction !== null && !patch.nextAction.trim()) throw new InvalidAiActionError("nextAction cannot be blank; use no update instead", "blank_field");
  if (patch.context !== null && !patch.context.trim()) throw new InvalidAiActionError("context cannot be blank; use no update instead", "blank_field");
  if (patch.habit && "minimumAction" in patch.habit && (!patch.habit.minimumAction.trim() || !patch.habit.desiredAction.trim())) {
    throw new InvalidAiActionError("habit mode requires minimumAction and desiredAction", "blank_field");
  }
  if (patch.checklist !== null) {
    if (patch.checklist.length > 20) throw new InvalidAiActionError("checklist may contain at most 20 items", "checklist");
    const normalized = patch.checklist.map((item) => item.text.trim());
    if (normalized.some((item) => !item)) throw new InvalidAiActionError("checklist items cannot be blank", "checklist");
    if (new Set(normalized.map((item) => item.toLocaleLowerCase())).size !== normalized.length) {
      throw new InvalidAiActionError("checklist items must not be duplicated", "checklist");
    }
  }
}

export function rescheduleFieldsFromWhen(when: When, ctx: ScheduleContext): { fields: RescheduleFields; timeMode: TimeMode } {
  const { timeMode, timezone: _timezone, ...fields } = compileWhen(when, ctx);
  return { fields, timeMode };
}

/**
 * The future schedule of a recurring series after a `reschedule` with scope=series.
 * The time mode stays: a series of deadlines cannot become a series of appointments
 * without re-materialising every occurrence's semantics.
 */
export function seriesDefinitionFromReschedule(action: ResolvedActionOf<"reschedule">, current: TaskDefinition): TaskDefinition {
  const ctx = { timezone: action.timezone, reviewTime: action.reviewTime };
  const schedule = compileWhen(action.when, ctx);
  if (schedule.timeMode === "fuzzy") throw new InvalidAiActionError("recurring item cannot use fuzzy time", "recurring_fuzzy");
  if (schedule.timeMode !== current.timeMode) throw new InvalidAiActionError("a series keeps its time mode; give the same kind of time", "series_time_mode");
  const { timeMode, timezone, ...timing } = schedule;
  const recurring = action.recurrence
    ? recurrenceFields(action.recurrence, schedule, timezone)
    : {
        recurrenceRule: current.recurrenceRule ?? "",
        recurrenceTimezone: timezone,
        ...(current.recurrenceEndLocalDate ? { recurrenceEndLocalDate: current.recurrenceEndLocalDate } : {}),
        ...(current.recurrenceExcludedLocalDates?.length ? { recurrenceExcludedLocalDates: current.recurrenceExcludedLocalDates } : {}),
      };
  const next: TaskDefinition = {
    kind: current.kind,
    importance: current.importance,
    timeMode,
    timezone,
    ...timing,
    ...recurring,
    ...(current.kind === "task" ? { missPolicy: action.recurrence?.missed ?? current.missPolicy ?? missPolicyDefault(timeMode) } : {}),
    ...(current.habitMode !== undefined ? { habitMode: current.habitMode } : {}),
    ...(current.minimumAction ? { minimumAction: current.minimumAction } : {}),
    ...(current.desiredAction ? { desiredAction: current.desiredAction } : {}),
    ...(current.habitTrigger ? { habitTrigger: current.habitTrigger } : {}),
  };
  const validation = validateTaskDefinition(next);
  if (!validation.ok) throw new InvalidAiActionError(validation.errors.join("; "), "task_definition");
  return next;
}

/** Deterministic button flows carry instants; the action journal keeps the model's `When` form. */
export function whenFromRescheduleFields(fields: RescheduleFields, timezone: string): When {
  if (fields.fuzzyHorizonText && fields.reviewAt) {
    return { mode: "fuzzy", horizonText: fields.fuzzyHorizonText, reviewDate: localDateAt(fields.reviewAt, timezone) };
  }
  if (fields.plannedStartAt) {
    const parts = localDateTimeAt(fields.plannedStartAt, timezone);
    const durationMinutes = fields.plannedEndAt ? Math.round((fields.plannedEndAt.getTime() - fields.plannedStartAt.getTime()) / 60_000) : null;
    return {
      mode: "exact",
      date: localDateAt(fields.plannedStartAt, timezone),
      time: `${pad(parts.hour)}:${pad(parts.minute)}`,
      durationMinutes: durationMinutes && durationMinutes > 0 ? durationMinutes : null,
    };
  }
  if (fields.plannedLocalDate) return { mode: "date", date: fields.plannedLocalDate };
  if (fields.dueAt) {
    const parts = localDateTimeAt(fields.dueAt, timezone);
    return { mode: "deadline", date: localDateAt(fields.dueAt, timezone), time: `${pad(parts.hour)}:${pad(parts.minute)}` };
  }
  if (fields.dueLocalDate) return { mode: "deadline", date: fields.dueLocalDate, time: null };
  throw new InvalidAiActionError("reschedule requires a new schedule", "schedule");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
