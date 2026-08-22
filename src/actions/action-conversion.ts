import { parseLocalDate, parseLocalTime } from "../core/timezone.js";
import { compileStructuredLocalSchedule } from "../core/local-schedule.js";
import { compileStructuredRecurrence } from "../core/recurrence-input.js";
import { recurrenceAnchorLocalDate } from "../core/recurrence.js";
import { validateNewTaskTiming, validateTaskDefinition } from "../core/task-policy.js";
import type { ChangeSeriesDraft, ProposedActionDraft, RescheduleOccurrenceDraft, UpdateTaskDraft } from "../core/ai-actions.js";
import type { ReminderRuleSpec } from "../core/reminder-planning.js";
import type { RescheduleFields } from "../core/reschedule.js";
import type { TaskDefinition } from "../core/types.js";
import type { CreateTaskInput } from "../tasks/tasks.service.js";

export class InvalidAiActionError extends Error {}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseInstant(value: string | null, field: string): Date | undefined {
  if (value === null) return undefined;
  if (!ISO_INSTANT.test(value)) throw new InvalidAiActionError(`${field} must be an ISO timestamp with an explicit timezone offset`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new InvalidAiActionError(`${field} is not a valid ISO timestamp`);
  return date;
}

function assertTimestampTimezone(value: string | null, parsed: Date | undefined, timezone: string, field: string): void {
  // Legacy timestamps are absolute instants. Their textual offset need not equal
  // the task timezone; downstream presentation canonicalizes the instant there.
  void value; void parsed; void timezone; void field;
}

function parseDateOnly(value: string | null, field: string): string | undefined {
  if (value === null) return undefined;
  try {
    parseLocalDate(value);
    return value;
  } catch {
    throw new InvalidAiActionError(`${field} is not a valid local date`);
  }
}

export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
  } catch {
    throw new InvalidAiActionError("timezone is not a valid IANA timezone");
  }
}

export function createTaskInputFromAction(action: Extract<ProposedActionDraft, { type: "create_task" }>, scope: {
  workspaceId: string;
  actorUserId: string;
  recipientUserId: string;
  sourceActionGroupId?: string;
  now: Date;
}): CreateTaskInput {
  assertTimezone(action.definition.timezone);
  if (action.definition.recurrenceTimezone) assertTimezone(action.definition.recurrenceTimezone);

  const legacyTiming = legacyScheduleFields(action.definition, action.definition.timezone, "");
  const structuredTiming = action.definition.localSchedule ? compileStructuredLocalSchedule(action.definition.localSchedule) : undefined;
  if (structuredTiming && hasLegacySchedule(action.definition)) throw new InvalidAiActionError("localSchedule cannot be combined with legacy timestamp fields");
  if (structuredTiming && (structuredTiming.timezone !== action.definition.timezone || structuredTiming.timeMode !== action.definition.timeMode)) {
    throw new InvalidAiActionError("localSchedule mode and timezone must match the task definition");
  }
  const timing = structuredTiming ?? legacyTiming;
  const structuredRecurrence = action.definition.recurrence ? compileStructuredRecurrence(action.definition.recurrence) : undefined;
  if (structuredRecurrence && action.definition.recurrenceRule) throw new InvalidAiActionError("recurrence cannot be combined with recurrenceRule");

  const definition: TaskDefinition = {
    kind: action.definition.kind,
    importance: action.definition.importance,
    timeMode: action.definition.timeMode,
    timezone: action.definition.timezone,
    ...timing,
    ...(!structuredTiming && action.definition.fuzzyHorizonText ? { fuzzyHorizonText: action.definition.fuzzyHorizonText } : {}),
    ...(structuredRecurrence ? {
      recurrenceRule: structuredRecurrence.recurrenceRule,
      recurrenceTimezone: action.definition.timezone,
      ...(structuredRecurrence.recurrenceEndLocalDate ? { recurrenceEndLocalDate: structuredRecurrence.recurrenceEndLocalDate } : {}),
      ...(structuredRecurrence.recurrenceExcludedLocalDates.length ? { recurrenceExcludedLocalDates: structuredRecurrence.recurrenceExcludedLocalDates } : {}),
    } : action.definition.recurrenceRule ? { recurrenceRule: action.definition.recurrenceRule, ...(action.definition.recurrenceTimezone ? { recurrenceTimezone: action.definition.recurrenceTimezone } : {}) } : {}),
    ...(action.definition.missPolicy ? { missPolicy: action.definition.missPolicy } : {}),
    habitMode: action.definition.habitMode,
    ...(action.definition.minimumAction ? { minimumAction: action.definition.minimumAction } : {}),
    ...(action.definition.desiredAction ? { desiredAction: action.definition.desiredAction } : {}),
    ...(action.definition.habitTrigger ? { habitTrigger: action.definition.habitTrigger } : {}),
  };
  if (structuredRecurrence && recurrenceAnchorLocalDate(definition, definition.recurrenceTimezone ?? definition.timezone) !== structuredRecurrence.recurrenceStartLocalDate) {
    throw new InvalidAiActionError("recurrence startsOn must match the schedule start date");
  }
  const validation = validateTaskDefinition(definition);
  if (!validation.ok) throw new InvalidAiActionError(validation.errors.join("; "));
  const timingErrors = validateNewTaskTiming(definition, scope.now);
  if (timingErrors.length) throw new InvalidAiActionError(timingErrors.join("; "));

  return {
    workspaceId: scope.workspaceId,
    actorUserId: scope.actorUserId,
    recipientUserId: scope.recipientUserId,
    ...(scope.sourceActionGroupId ? { sourceActionGroupId: scope.sourceActionGroupId } : {}),
    title: action.title,
    definition,
    ...(action.why ? { why: action.why } : {}),
    ...(action.nextAction ? { nextAction: action.nextAction } : {}),
    ...(action.context ? { context: action.context } : {}),
    ...(action.checklist ? { checklist: action.checklist.map((item) => ({ text: item.text, done: item.done })) } : {}),
    now: scope.now,
  };
}

export function validateUpdateTaskAction(action: UpdateTaskDraft): void {
  const patch = action.patch;
  if (patch.title === null && patch.why === null && patch.nextAction === null && patch.context === null && patch.importance === null && patch.checklist === null
    && patch.habitMode === null && patch.minimumAction === null && patch.desiredAction === null && patch.habitTrigger === null) {
    throw new InvalidAiActionError("update_task patch must change at least one field");
  }
  if (patch.title !== null && !patch.title.trim()) throw new InvalidAiActionError("task title cannot be empty");
  if (patch.why !== null && !patch.why.trim()) throw new InvalidAiActionError("why cannot be blank; use no update instead");
  if (patch.nextAction !== null && !patch.nextAction.trim()) throw new InvalidAiActionError("nextAction cannot be blank; use no update instead");
  if (patch.context !== null && !patch.context.trim()) throw new InvalidAiActionError("context cannot be blank; use no update instead");
  if (patch.habitMode === true && (!patch.minimumAction?.trim() || !patch.desiredAction?.trim())) {
    throw new InvalidAiActionError("habit mode requires minimumAction and desiredAction");
  }
  if (patch.minimumAction !== null && !patch.minimumAction.trim()) throw new InvalidAiActionError("minimumAction cannot be blank");
  if (patch.desiredAction !== null && !patch.desiredAction.trim()) throw new InvalidAiActionError("desiredAction cannot be blank");
  if (patch.habitTrigger !== null && !patch.habitTrigger.trim()) throw new InvalidAiActionError("habitTrigger cannot be blank");
  if (patch.checklist !== null) {
    if (patch.checklist.length > 20) throw new InvalidAiActionError("checklist may contain at most 20 items");
    const normalized = patch.checklist.map((item) => item.text.trim());
    if (normalized.some((item) => !item)) throw new InvalidAiActionError("checklist items cannot be blank");
    if (new Set(normalized.map((item) => item.toLocaleLowerCase())).size !== normalized.length) {
      throw new InvalidAiActionError("checklist items must not be duplicated");
    }
  }
}

export function rescheduleFieldsFromAction(action: RescheduleOccurrenceDraft): RescheduleFields {
  const timezone = action.schedule.timezone;
  assertTimezone(timezone);
  if (action.schedule.localSchedule) {
    if (hasLegacySchedule(action.schedule)) throw new InvalidAiActionError("localSchedule cannot be combined with legacy timestamp fields");
    const compiled = compileStructuredLocalSchedule(action.schedule.localSchedule);
    if (compiled.timezone !== timezone) throw new InvalidAiActionError("localSchedule timezone must match the target occurrence timezone");
    const { timeMode: _mode, timezone: _timezone, ...fields } = compiled;
    return fields;
  }
  const plannedStartAt = parseInstant(action.schedule.plannedStartAt, "plannedStartAt");
  const plannedEndAt = parseInstant(action.schedule.plannedEndAt, "plannedEndAt");
  const plannedLocalDate = parseDateOnly(action.schedule.plannedLocalDate, "plannedLocalDate");
  const dueAt = parseInstant(action.schedule.dueAt, "dueAt");
  const dueLocalDate = parseDateOnly(action.schedule.dueLocalDate, "dueLocalDate");
  const reviewAt = parseInstant(action.schedule.reviewAt, "reviewAt");
  assertTimestampTimezone(action.schedule.plannedStartAt, plannedStartAt, timezone, "plannedStartAt");
  assertTimestampTimezone(action.schedule.plannedEndAt, plannedEndAt, timezone, "plannedEndAt");
  assertTimestampTimezone(action.schedule.dueAt, dueAt, timezone, "dueAt");
  assertTimestampTimezone(action.schedule.reviewAt, reviewAt, timezone, "reviewAt");
  if (!plannedStartAt && !plannedEndAt && !plannedLocalDate && !dueAt && !dueLocalDate && !action.schedule.fuzzyHorizonText && !reviewAt) {
    throw new InvalidAiActionError("reschedule_occurrence requires a new schedule");
  }
  return {
    ...(plannedStartAt ? { plannedStartAt } : {}),
    ...(plannedEndAt ? { plannedEndAt } : {}),
    ...(plannedLocalDate ? { plannedLocalDate } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(dueLocalDate ? { dueLocalDate } : {}),
    ...(action.schedule.fuzzyHorizonText ? { fuzzyHorizonText: action.schedule.fuzzyHorizonText.trim() } : {}),
    ...(reviewAt ? { reviewAt } : {}),
  };
}


export function seriesDefinitionFromAction(
  action: ChangeSeriesDraft,
  current: TaskDefinition,
): TaskDefinition {
  if (action.operation !== "edit" || !action.edit) throw new InvalidAiActionError("series edit payload is required");
  const edit = action.edit;
  assertTimezone(edit.timezone);
  assertTimezone(edit.recurrenceTimezone);
  if (edit.timezone !== edit.recurrenceTimezone) throw new InvalidAiActionError("series timezone and recurrenceTimezone must match");

  if (edit.localSchedule && hasLegacySchedule(edit)) throw new InvalidAiActionError("series localSchedule cannot be combined with legacy timestamp fields");
  const compiledSchedule = edit.localSchedule ? compileStructuredLocalSchedule(edit.localSchedule) : undefined;
  if (compiledSchedule && (compiledSchedule.timezone !== edit.timezone || compiledSchedule.timeMode !== current.timeMode)) {
    throw new InvalidAiActionError("series localSchedule mode and timezone must match the existing task");
  }
  const plannedStartAt = compiledSchedule?.plannedStartAt ?? parseInstant(edit.plannedStartAt, "series.plannedStartAt");
  const plannedEndAt = parseInstant(edit.plannedEndAt, "series.plannedEndAt");
  const plannedLocalDate = parseDateOnly(edit.plannedLocalDate, "series.plannedLocalDate");
  const dueAt = parseInstant(edit.dueAt, "series.dueAt");
  const dueLocalDate = parseDateOnly(edit.dueLocalDate, "series.dueLocalDate");
  assertTimestampTimezone(edit.plannedStartAt, plannedStartAt, edit.timezone, "series.plannedStartAt");
  assertTimestampTimezone(edit.plannedEndAt, plannedEndAt, edit.timezone, "series.plannedEndAt");
  assertTimestampTimezone(edit.dueAt, dueAt, edit.timezone, "series.dueAt");

  const structuredRecurrence = edit.recurrence ? compileStructuredRecurrence(edit.recurrence) : undefined;
  if (structuredRecurrence && edit.recurrenceRule) throw new InvalidAiActionError("series recurrence cannot be combined with recurrenceRule");
  const next: TaskDefinition = {
    kind: current.kind,
    importance: current.importance,
    timeMode: current.timeMode,
    timezone: edit.timezone,
    recurrenceRule: structuredRecurrence?.recurrenceRule ?? edit.recurrenceRule?.trim() ?? "",
    recurrenceTimezone: edit.recurrenceTimezone,
    ...(edit.missPolicy ? { missPolicy: edit.missPolicy } : {}),
    ...(current.habitMode !== undefined ? { habitMode: current.habitMode } : {}),
    ...(current.minimumAction ? { minimumAction: current.minimumAction } : {}),
    ...(current.desiredAction ? { desiredAction: current.desiredAction } : {}),
    ...(current.habitTrigger ? { habitTrigger: current.habitTrigger } : {}),
    ...(compiledSchedule ? omitCompiledMode(compiledSchedule) : {
      ...(plannedStartAt ? { plannedStartAt } : {}),
      ...(plannedEndAt ? { plannedEndAt } : {}),
      ...(plannedLocalDate ? { plannedLocalDate } : {}),
      ...(dueAt ? { dueAt } : {}),
      ...(dueLocalDate ? { dueLocalDate } : {}),
    }),
    ...(structuredRecurrence?.recurrenceEndLocalDate ? { recurrenceEndLocalDate: structuredRecurrence.recurrenceEndLocalDate } : {}),
    ...(structuredRecurrence?.recurrenceExcludedLocalDates.length ? { recurrenceExcludedLocalDates: structuredRecurrence.recurrenceExcludedLocalDates } : {}),
  };
  if (structuredRecurrence && recurrenceAnchorLocalDate(next, next.recurrenceTimezone ?? next.timezone) !== structuredRecurrence.recurrenceStartLocalDate) {
    throw new InvalidAiActionError("series recurrence startsOn must match the schedule start date");
  }
  const validation = validateTaskDefinition(next);
  if (!validation.ok) throw new InvalidAiActionError(validation.errors.join("; "));
  return next;
}

type LegacyScheduleShape = {
  plannedStartAt: string | null; plannedEndAt: string | null; plannedLocalDate: string | null;
  dueAt: string | null; dueLocalDate: string | null; reviewAt?: string | null; fuzzyHorizonText?: string | null;
};

function hasLegacySchedule(value: LegacyScheduleShape): boolean {
  return Boolean(value.plannedStartAt || value.plannedEndAt || value.plannedLocalDate || value.dueAt || value.dueLocalDate || value.reviewAt || value.fuzzyHorizonText);
}

function legacyScheduleFields(value: LegacyScheduleShape, timezone: string, prefix: string): Omit<ReturnType<typeof compileStructuredLocalSchedule>, "timeMode" | "timezone"> {
  const plannedStartAt = parseInstant(value.plannedStartAt, `${prefix}plannedStartAt`);
  const plannedEndAt = parseInstant(value.plannedEndAt, `${prefix}plannedEndAt`);
  const plannedLocalDate = parseDateOnly(value.plannedLocalDate, `${prefix}plannedLocalDate`);
  const dueAt = parseInstant(value.dueAt, `${prefix}dueAt`);
  const dueLocalDate = parseDateOnly(value.dueLocalDate, `${prefix}dueLocalDate`);
  const reviewAt = parseInstant(value.reviewAt ?? null, `${prefix}reviewAt`);
  // Legacy absolute timestamps denote instants. Z and an equivalent explicit offset
  // therefore canonicalize to the declared IANA timezone instead of being rejected.
  void timezone;
  return {
    ...(plannedStartAt ? { plannedStartAt } : {}), ...(plannedEndAt ? { plannedEndAt } : {}),
    ...(plannedLocalDate ? { plannedLocalDate } : {}), ...(dueAt ? { dueAt } : {}),
    ...(dueLocalDate ? { dueLocalDate } : {}), ...(reviewAt ? { reviewAt } : {}),
  };
}

function omitCompiledMode(value: ReturnType<typeof compileStructuredLocalSchedule>): Omit<ReturnType<typeof compileStructuredLocalSchedule>, "timeMode" | "timezone"> {
  const { timeMode: _mode, timezone: _timezone, ...fields } = value;
  return fields;
}

export function reminderRuleFromAction(action: Extract<ProposedActionDraft, { type: "change_reminder" }>): ReminderRuleSpec | undefined {
  if (action.mode === "clear") { if (action.reminder !== null) throw new InvalidAiActionError("clear reminder requires reminder=null"); return undefined; }
  if (!action.reminder) throw new InvalidAiActionError("reminder is required");
  if (action.reminder.quietPolicy === "bypass" && !action.quietBypassExplicit && action.source === "user_explicit") {
    throw new InvalidAiActionError("quiet-hours bypass must be explicit");
  }
  if (action.reminder.triggerKind === "exact") {
    const exactAt = parseInstant(action.reminder.exactAt, "reminder.exactAt");
    if (!exactAt || action.reminder.anchor !== null || action.reminder.offsetMinutes !== null || action.reminder.daysOffset !== null || action.reminder.localTime !== null) {
      throw new InvalidAiActionError("exact reminder requires only exactAt");
    }
    return { triggerKind: "exact", exactAt, purpose: "user_reminder", quietPolicy: action.reminder.quietPolicy, origin: "explicit" };
  }
  if (action.reminder.triggerKind === "relative_timestamp") {
    if (!action.reminder.anchor || action.reminder.offsetMinutes === null || action.reminder.exactAt !== null || action.reminder.daysOffset !== null || action.reminder.localTime !== null) {
      throw new InvalidAiActionError("timestamp-relative reminder requires anchor and offsetMinutes");
    }
    return { triggerKind: "relative_timestamp", anchor: action.reminder.anchor, offsetSeconds: action.reminder.offsetMinutes * 60, purpose: "user_reminder", quietPolicy: action.reminder.quietPolicy, origin: "explicit" };
  }
  if (!action.reminder.anchor || action.reminder.anchor === "planned_end" || action.reminder.daysOffset === null || !action.reminder.localTime || action.reminder.exactAt !== null || action.reminder.offsetMinutes !== null) {
    throw new InvalidAiActionError("date-relative reminder requires planned_start/due_at, daysOffset and localTime");
  }
  parseLocalTime(action.reminder.localTime);
  return {
    triggerKind: "local_date", anchor: action.reminder.anchor, daysOffset: action.reminder.daysOffset, localTime: action.reminder.localTime,
    purpose: "user_reminder", quietPolicy: action.reminder.quietPolicy, origin: "explicit",
  };
}
