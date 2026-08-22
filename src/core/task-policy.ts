import { parseRecurrenceRule, recurrenceAnchorLocalDate } from "./recurrence.js";
import { compareLocalDates, localDateAt, localDateTimeAt, parseLocalDate } from "./timezone.js";
import type { TaskDefinition } from "./types.js";

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function validateTaskDefinition(task: TaskDefinition): ValidationResult {
  const errors: string[] = [];
  const recurring = present(task.recurrenceRule);
  let recurrence: ReturnType<typeof parseRecurrenceRule> | undefined;

  if (task.kind === "event" && !["point", "window"].includes(task.timeMode)) {
    errors.push("event supports only point or window time modes");
  }
  if (recurring && task.timeMode === "fuzzy") errors.push("recurring item cannot use fuzzy time");
  if (recurring && task.recurrenceRule) {
    try {
      recurrence = parseRecurrenceRule(task.recurrenceRule);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "invalid recurrence rule");
    }
  }
  if (!recurring && task.recurrenceEndLocalDate) errors.push("recurrenceEndLocalDate is only valid for recurring tasks");
  if (!recurring && task.recurrenceExcludedLocalDates?.length) errors.push("recurrenceExcludedLocalDates are only valid for recurring tasks");
  if (recurring) {
    let anchor: string | undefined;
    try {
      anchor = recurrenceAnchorLocalDate(task, task.recurrenceTimezone ?? task.timezone);
    } catch {
      // Existing timing validation reports the missing anchor with the mode-specific message.
    }
    if (task.recurrenceEndLocalDate) {
      try {
        parseLocalDate(task.recurrenceEndLocalDate);
        if (anchor && compareLocalDates(task.recurrenceEndLocalDate, anchor) < 0) errors.push("recurrence end must not be before start");
      } catch {
        errors.push("invalid recurrenceEndLocalDate");
      }
    }
    const excluded = task.recurrenceExcludedLocalDates ?? [];
    if (excluded.length > 32) errors.push("recurrence supports at most 32 excluded dates");
    if (new Set(excluded).size !== excluded.length) errors.push("recurrence excluded dates must be distinct");
    for (const date of excluded) {
      try {
        parseLocalDate(date);
        if (anchor && compareLocalDates(date, anchor) < 0) errors.push("excluded recurrence date must not be before start");
        if (task.recurrenceEndLocalDate && compareLocalDates(date, task.recurrenceEndLocalDate) > 0) errors.push("excluded recurrence date must not be after end");
      } catch {
        errors.push("invalid recurrence excluded date");
      }
    }
  }
  if (recurrence?.byTime && (!task.plannedStartAt || (task.timeMode !== "point" && task.timeMode !== "window"))) {
    errors.push("BYTIME requires a point or window recurrence with plannedStartAt");
  }
  if (recurrence?.byTime && task.plannedStartAt) {
    const local = localDateTimeAt(task.plannedStartAt, task.recurrenceTimezone ?? task.timezone);
    const startTime = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
    if (!recurrence.byTime.includes(startTime)) errors.push("plannedStartAt time must be included in BYTIME");
  }
  if (task.habitMode && (task.kind !== "task" || !recurring)) errors.push("habit mode requires a recurring task");
  if (task.habitMode && (!task.minimumAction?.trim() || !task.desiredAction?.trim())) {
    errors.push("habit mode requires minimumAction and desiredAction");
  }

  if (task.timeMode === "point") {
    if (!task.plannedStartAt) errors.push("point requires plannedStartAt");
    if (task.plannedEndAt || task.plannedLocalDate || task.dueAt || task.dueLocalDate || task.fuzzyHorizonText) {
      errors.push("point contains fields from another time mode");
    }
  }

  if (task.timeMode === "window") {
    const exact = Boolean(task.plannedStartAt || task.plannedEndAt);
    const allDay = Boolean(task.plannedLocalDate);
    if (exact === allDay) errors.push("window requires either exact start/end or plannedLocalDate");
    if (exact && (!task.plannedStartAt || !task.plannedEndAt)) errors.push("exact window requires start and end");
    if (task.plannedStartAt && task.plannedEndAt && task.plannedEndAt <= task.plannedStartAt) {
      errors.push("window end must be after start");
    }
    if (task.dueAt || task.dueLocalDate || task.fuzzyHorizonText) errors.push("window contains fields from another time mode");
  }

  if (task.timeMode === "deadline") {
    if (Boolean(task.dueAt) === Boolean(task.dueLocalDate)) errors.push("deadline requires exactly one due boundary");
    if (task.importance === "critical" && !task.dueAt) errors.push("critical deadline requires exact dueAt");
    if (task.plannedEndAt && !task.plannedStartAt) errors.push("plannedEndAt requires plannedStartAt");
    if (task.plannedStartAt && task.plannedEndAt && task.plannedEndAt <= task.plannedStartAt) {
      errors.push("plannedEndAt must be after plannedStartAt");
    }
    if (task.dueAt && task.plannedStartAt && task.plannedStartAt > task.dueAt) errors.push("plannedStartAt cannot be after dueAt");
    if (task.dueAt && task.plannedEndAt && task.plannedEndAt > task.dueAt) errors.push("plannedEndAt cannot be after dueAt");
    if (task.fuzzyHorizonText) errors.push("deadline cannot also be fuzzy");
  }

  if (task.timeMode === "fuzzy") {
    if (!task.reviewAt) errors.push("fuzzy task requires reviewAt planning checkpoint");
    if (!task.fuzzyHorizonText?.trim()) errors.push("fuzzy task requires fuzzyHorizonText");
    if (task.kind !== "task") errors.push("event cannot be fuzzy");
    if (task.plannedStartAt || task.plannedEndAt || task.plannedLocalDate || task.dueAt || task.dueLocalDate) {
      errors.push("fuzzy task cannot contain concrete execution time");
    }
  }

  if (recurring && !task.recurrenceTimezone) errors.push("recurring item requires recurrenceTimezone");
  if (recurring && task.kind === "task" && !task.missPolicy) errors.push("recurring task requires missPolicy");
  if (!recurring && task.missPolicy) errors.push("missPolicy is only valid for recurring tasks");

  return errors.length ? { ok: false, errors } : { ok: true };
}

export function taskCreatesOccurrence(task: TaskDefinition): boolean {
  return task.timeMode !== "fuzzy";
}

/** Reject concrete one-time boundaries that would immediately be overdue. */
export function validateOneTimeTaskTiming(task: TaskDefinition, now: Date, operation: string): string[] {
  if (task.recurrenceRule) return [];
  return validateConcreteTaskTiming(task, now, operation);
}

function validateConcreteTaskTiming(task: TaskDefinition, now: Date, operation: string): string[] {
  const errors: string[] = [];
  const exactBoundaries: Array<[string, Date | undefined]> = [
    ["plannedStartAt", task.plannedStartAt],
    ["plannedEndAt", task.plannedEndAt],
    ["dueAt", task.dueAt],
    ["reviewAt", task.reviewAt],
  ];
  for (const [field, value] of exactBoundaries) {
    if (value && value < now) errors.push(`${field} must not be in the past when ${operation}`);
  }
  const today = localDateAt(now, task.timezone);
  for (const [field, value] of [["plannedLocalDate", task.plannedLocalDate], ["dueLocalDate", task.dueLocalDate]] as const) {
    if (value && value < today) errors.push(`${field} must not be before today when ${operation}`);
  }
  return errors;
}

export function validateNewTaskTiming(task: TaskDefinition, now: Date): string[] {
  return task.recurrenceRule
    ? validateConcreteTaskTiming(task, now, "creating a recurring task")
    : validateOneTimeTaskTiming(task, now, "creating a one-time task");
}

export function isRescheduleReasonRequired(importance: TaskDefinition["importance"], previousReschedules: number): boolean {
  if (importance === "required" || importance === "critical") return true;
  return previousReschedules >= 1;
}
