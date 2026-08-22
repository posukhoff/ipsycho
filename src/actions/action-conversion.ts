import { parseLocalDate, parseLocalTime } from "../core/timezone.js";
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

function inputOffsetMinutes(value: string): number {
  if (value.endsWith("Z")) return 0;
  const match = /([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new InvalidAiActionError("timestamp has no timezone offset");
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function ianaOffsetMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

function assertTimestampTimezone(value: string | null, parsed: Date | undefined, timezone: string, field: string): void {
  if (value === null || !parsed) return;
  if (inputOffsetMinutes(value) !== ianaOffsetMinutes(parsed, timezone)) {
    throw new InvalidAiActionError(`${field} offset does not match timezone ${timezone}`);
  }
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

  const plannedStartAt = parseInstant(action.definition.plannedStartAt, "plannedStartAt");
  const plannedEndAt = parseInstant(action.definition.plannedEndAt, "plannedEndAt");
  const plannedLocalDate = parseDateOnly(action.definition.plannedLocalDate, "plannedLocalDate");
  const dueAt = parseInstant(action.definition.dueAt, "dueAt");
  const dueLocalDate = parseDateOnly(action.definition.dueLocalDate, "dueLocalDate");
  const reviewAt = parseInstant(action.definition.reviewAt, "reviewAt");

  assertTimestampTimezone(action.definition.plannedStartAt, plannedStartAt, action.definition.timezone, "plannedStartAt");
  assertTimestampTimezone(action.definition.plannedEndAt, plannedEndAt, action.definition.timezone, "plannedEndAt");
  assertTimestampTimezone(action.definition.dueAt, dueAt, action.definition.timezone, "dueAt");
  assertTimestampTimezone(action.definition.reviewAt, reviewAt, action.definition.timezone, "reviewAt");

  const definition: TaskDefinition = {
    kind: action.definition.kind,
    importance: action.definition.importance,
    timeMode: action.definition.timeMode,
    timezone: action.definition.timezone,
    ...(plannedStartAt ? { plannedStartAt } : {}),
    ...(plannedEndAt ? { plannedEndAt } : {}),
    ...(plannedLocalDate ? { plannedLocalDate } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(dueLocalDate ? { dueLocalDate } : {}),
    ...(action.definition.fuzzyHorizonText ? { fuzzyHorizonText: action.definition.fuzzyHorizonText } : {}),
    ...(reviewAt ? { reviewAt } : {}),
    ...(action.definition.recurrenceRule ? { recurrenceRule: action.definition.recurrenceRule } : {}),
    ...(action.definition.recurrenceTimezone ? { recurrenceTimezone: action.definition.recurrenceTimezone } : {}),
    ...(action.definition.missPolicy ? { missPolicy: action.definition.missPolicy } : {}),
    habitMode: action.definition.habitMode,
    ...(action.definition.minimumAction ? { minimumAction: action.definition.minimumAction } : {}),
    ...(action.definition.desiredAction ? { desiredAction: action.definition.desiredAction } : {}),
    ...(action.definition.habitTrigger ? { habitTrigger: action.definition.habitTrigger } : {}),
  };
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

  const plannedStartAt = parseInstant(edit.plannedStartAt, "series.plannedStartAt");
  const plannedEndAt = parseInstant(edit.plannedEndAt, "series.plannedEndAt");
  const plannedLocalDate = parseDateOnly(edit.plannedLocalDate, "series.plannedLocalDate");
  const dueAt = parseInstant(edit.dueAt, "series.dueAt");
  const dueLocalDate = parseDateOnly(edit.dueLocalDate, "series.dueLocalDate");
  assertTimestampTimezone(edit.plannedStartAt, plannedStartAt, edit.timezone, "series.plannedStartAt");
  assertTimestampTimezone(edit.plannedEndAt, plannedEndAt, edit.timezone, "series.plannedEndAt");
  assertTimestampTimezone(edit.dueAt, dueAt, edit.timezone, "series.dueAt");

  const next: TaskDefinition = {
    kind: current.kind,
    importance: current.importance,
    timeMode: current.timeMode,
    timezone: edit.timezone,
    recurrenceRule: edit.recurrenceRule.trim(),
    recurrenceTimezone: edit.recurrenceTimezone,
    ...(edit.missPolicy ? { missPolicy: edit.missPolicy } : {}),
    ...(current.habitMode !== undefined ? { habitMode: current.habitMode } : {}),
    ...(current.minimumAction ? { minimumAction: current.minimumAction } : {}),
    ...(current.desiredAction ? { desiredAction: current.desiredAction } : {}),
    ...(current.habitTrigger ? { habitTrigger: current.habitTrigger } : {}),
    ...(plannedStartAt ? { plannedStartAt } : {}),
    ...(plannedEndAt ? { plannedEndAt } : {}),
    ...(plannedLocalDate ? { plannedLocalDate } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(dueLocalDate ? { dueLocalDate } : {}),
  };
  const validation = validateTaskDefinition(next);
  if (!validation.ok) throw new InvalidAiActionError(validation.errors.join("; "));
  return next;
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
