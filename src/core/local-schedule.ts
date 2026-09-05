import { compareLocalDates, localDateAndTimeToUtc, localDateAt, parseLocalDate, parseLocalTime, shiftLocalDate } from "./timezone.js";

export type LocalScheduleMode = "exact" | "window" | "date" | "deadline" | "fuzzy";

export interface StructuredLocalScheduleInput {
  mode: LocalScheduleMode;
  timezone: string;
  startDate?: string | null;
  startTime?: string | null;
  endDate?: string | null;
  endTime?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  durationMinutes?: number | null;
  fuzzyHorizonText?: string | null;
  reviewDate?: string | null;
  reviewTime?: string | null;
}

export interface CompiledLocalSchedule {
  timeMode: "point" | "window" | "deadline" | "fuzzy";
  timezone: string;
  plannedStartAt?: Date;
  plannedEndAt?: Date;
  plannedLocalDate?: string;
  dueAt?: Date;
  dueLocalDate?: string;
  fuzzyHorizonText?: string;
  reviewAt?: Date;
}

export function compileStructuredLocalSchedule(input: StructuredLocalScheduleInput): CompiledLocalSchedule {
  assertTimezone(input.timezone);
  const startDate = localDate(input.startDate, "startDate");
  const startTime = localTime(input.startTime, "startTime");
  const endDate = localDate(input.endDate, "endDate");
  const endTime = localTime(input.endTime, "endTime");
  const dueDate = localDate(input.dueDate, "dueDate");
  const dueTime = localTime(input.dueTime, "dueTime");
  const reviewDate = localDate(input.reviewDate, "reviewDate");
  const reviewTime = localTime(input.reviewTime, "reviewTime");
  const duration = input.durationMinutes;
  if (duration !== null && duration !== undefined && (!Number.isInteger(duration) || duration < 1 || duration > 7 * 24 * 60)) {
    throw new Error("durationMinutes must be an integer between 1 and 10080");
  }

  if (input.mode === "exact") {
    requireOnlyAbsent({ endDate, endTime, dueDate, dueTime, duration, fuzzy: input.fuzzyHorizonText, reviewDate, reviewTime }, "exact");
    if (!startDate || !startTime) throw new Error("exact schedule requires startDate and startTime");
    return { timeMode: "point", timezone: input.timezone, plannedStartAt: instant(startDate, startTime, input.timezone) };
  }
  if (input.mode === "date") {
    requireOnlyAbsent({ startTime, endDate, endTime, dueDate, dueTime, duration, fuzzy: input.fuzzyHorizonText, reviewDate, reviewTime }, "date");
    if (!startDate) throw new Error("date schedule requires startDate");
    // A day without a clock time is an all-day window: it materialises an occurrence and
    // gets the morning default reminder, whereas a point requires an exact start.
    return { timeMode: "window", timezone: input.timezone, plannedLocalDate: startDate };
  }
  if (input.mode === "window") {
    requireOnlyAbsent({ dueDate, dueTime, fuzzy: input.fuzzyHorizonText, reviewDate, reviewTime }, "window");
    if (!startDate) throw new Error("window schedule requires startDate");
    if (!startTime) {
      if (endDate || endTime || duration) throw new Error("date-only window cannot include end time or duration");
      return { timeMode: "window", timezone: input.timezone, plannedLocalDate: startDate };
    }
    if (duration && (endDate || endTime)) throw new Error("window must use durationMinutes or an explicit end, not both");
    const plannedStartAt = instant(startDate, startTime, input.timezone);
    let plannedEndAt: Date;
    if (duration) plannedEndAt = new Date(plannedStartAt.getTime() + duration * 60_000);
    else {
      if (!endTime) throw new Error("window requires endTime or durationMinutes");
      const resolvedEndDate = endDate ?? (endTime <= startTime ? shiftLocalDate(startDate, 1) : startDate);
      plannedEndAt = instant(resolvedEndDate, endTime, input.timezone);
    }
    if (plannedEndAt <= plannedStartAt) throw new Error("window end must be after start");
    return { timeMode: "window", timezone: input.timezone, plannedStartAt, plannedEndAt };
  }
  if (input.mode === "deadline") {
    requireOnlyAbsent({ endDate, endTime, duration, fuzzy: input.fuzzyHorizonText, reviewDate, reviewTime }, "deadline");
    if (!dueDate) throw new Error("deadline schedule requires dueDate");
    if (startTime && !startDate) throw new Error("deadline startTime requires startDate");
    const result: CompiledLocalSchedule = { timeMode: "deadline", timezone: input.timezone };
    if (startDate && startTime) result.plannedStartAt = instant(startDate, startTime, input.timezone);
    else if (startDate) result.plannedLocalDate = startDate;
    if (dueTime) result.dueAt = instant(dueDate, dueTime, input.timezone);
    else result.dueLocalDate = dueDate;
    if (startDate && compareLocalDates(startDate, dueDate) > 0) throw new Error("deadline start must not be after due date");
    return result;
  }
  requireOnlyAbsent({ startDate, startTime, endDate, endTime, dueDate, dueTime, duration }, "fuzzy");
  const fuzzy = input.fuzzyHorizonText?.trim();
  if (!fuzzy || !reviewDate || !reviewTime) throw new Error("fuzzy schedule requires fuzzyHorizonText, reviewDate and reviewTime");
  return {
    timeMode: "fuzzy",
    timezone: input.timezone,
    fuzzyHorizonText: fuzzy,
    reviewAt: instant(reviewDate, reviewTime, input.timezone),
  };
}

function localDate(value: string | null | undefined, field: string): string | undefined {
  if (!value) return undefined;
  try {
    parseLocalDate(value);
  } catch {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
  return value;
}

function localTime(value: string | null | undefined, field: string): string | undefined {
  if (!value) return undefined;
  try {
    parseLocalTime(value);
  } catch {
    throw new Error(`${field} must be HH:mm`);
  }
  return value;
}

function instant(date: string, time: string, timezone: string): Date {
  return localDateAndTimeToUtc(date, time, timezone).date;
}

function requireOnlyAbsent(values: Record<string, unknown>, mode: string): void {
  const present = Object.entries(values).find(([, value]) => value !== null && value !== undefined && value !== "");
  if (present) throw new Error(`${present[0]} is not valid for ${mode} schedule`);
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error("timezone is not a valid IANA timezone");
  }
}

/**
 * Does this occurrence belong to the user's local day? Overdue work belongs to every day until it
 * is closed. Today's screen and the morning digest asked this question with two identical copies
 * of the same five conditions.
 */
export function occurrenceFallsOnLocalDate(
  input: {
    timeMode: string;
    overdue: boolean;
    timezone: string;
    plannedLocalDate?: string | null;
    dueLocalDate?: string | null;
    plannedStartAt?: Date | null;
    plannedEndAt?: Date | null;
    dueAt?: Date | null;
  },
  localDate: string,
): boolean {
  if (input.overdue) return true;
  if (input.plannedLocalDate === localDate || input.dueLocalDate === localDate) return true;
  if (input.plannedStartAt && localDateAt(input.plannedStartAt, input.timezone) === localDate) return true;
  if (input.dueAt && localDateAt(input.dueAt, input.timezone) === localDate) return true;
  if (input.timeMode === "window" && input.plannedEndAt && localDateAt(input.plannedEndAt, input.timezone) === localDate) return true;
  return false;
}

/**
 * The one local day an occurrence belongs to, independent of today. `occurrenceFallsOnLocalDate`
 * answers "is it on this day", which is true for overdue work on every day; a date window needs
 * the day itself. The order matches how a card reads the occurrence: planned before due.
 */
export function occurrenceLocalDate(input: {
  timezone: string;
  plannedLocalDate?: string | null;
  dueLocalDate?: string | null;
  plannedStartAt?: Date | string | null;
  dueAt?: Date | string | null;
}): string | null {
  if (input.plannedStartAt) return localDateAt(new Date(input.plannedStartAt), input.timezone);
  if (input.plannedLocalDate) return input.plannedLocalDate;
  if (input.dueAt) return localDateAt(new Date(input.dueAt), input.timezone);
  if (input.dueLocalDate) return input.dueLocalDate;
  return null;
}
