import { compareLocalDates, parseLocalDate, parseLocalTime } from "./timezone.js";

export type StructuredRecurrenceFrequency = "daily" | "weekly" | "monthly";
export type StructuredRecurrenceWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface StructuredRecurrenceInput {
  frequency: StructuredRecurrenceFrequency;
  interval: number;
  startsOn: string;
  endsOn?: string | null;
  weekdays?: readonly StructuredRecurrenceWeekday[] | null;
  monthDays?: readonly number[] | null;
  localTimes?: readonly string[] | null;
  excludedLocalDates?: readonly string[] | null;
}

export interface CompiledRecurrenceInput {
  recurrenceRule: string;
  recurrenceStartLocalDate: string;
  recurrenceEndLocalDate?: string;
  recurrenceExcludedLocalDates: string[];
}

const WEEKDAYS = new Set<StructuredRecurrenceWeekday>(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

export function compileStructuredRecurrence(input: StructuredRecurrenceInput): CompiledRecurrenceInput {
  parseLocalDate(input.startsOn);
  if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 365) {
    throw new Error("recurrence interval must be a positive integer <= 365");
  }

  const weekdays = distinct(input.weekdays ?? []);
  const monthDays = distinct(input.monthDays ?? []);
  const localTimes = distinct(input.localTimes ?? []).sort();
  const excludedLocalDates = distinct(input.excludedLocalDates ?? []).sort();

  if (weekdays.some((day) => !WEEKDAYS.has(day))) throw new Error("invalid recurrence weekday");
  if (monthDays.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) throw new Error("invalid recurrence month day");
  for (const time of localTimes) parseLocalTime(time);
  if (localTimes.length > 16) throw new Error("recurrence supports at most 16 local times");
  if (excludedLocalDates.length > 32) throw new Error("recurrence supports at most 32 excluded dates");
  for (const date of excludedLocalDates) parseLocalDate(date);

  if (input.frequency !== "weekly" && weekdays.length) throw new Error("weekdays are supported only for weekly recurrence");
  if (input.frequency !== "monthly" && monthDays.length) throw new Error("month days are supported only for monthly recurrence");
  if (input.frequency !== "daily" && localTimes.length) throw new Error("multiple local times are supported only for daily recurrence");

  let recurrenceEndLocalDate: string | undefined;
  if (input.endsOn) {
    parseLocalDate(input.endsOn);
    if (compareLocalDates(input.endsOn, input.startsOn) < 0) throw new Error("recurrence end must not be before start");
    recurrenceEndLocalDate = input.endsOn;
  }
  for (const date of excludedLocalDates) {
    if (compareLocalDates(date, input.startsOn) < 0) throw new Error("excluded recurrence date must not be before start");
    if (recurrenceEndLocalDate && compareLocalDates(date, recurrenceEndLocalDate) > 0) {
      throw new Error("excluded recurrence date must not be after end");
    }
  }

  const parts = [`FREQ=${input.frequency.toUpperCase()}`, `INTERVAL=${input.interval}`];
  if (weekdays.length) parts.push(`BYDAY=${weekdays.join(",")}`);
  if (monthDays.length) parts.push(`BYMONTHDAY=${monthDays.join(",")}`);
  if (localTimes.length) parts.push(`BYTIME=${localTimes.join(",")}`);
  return {
    recurrenceRule: parts.join(";"),
    recurrenceStartLocalDate: input.startsOn,
    ...(recurrenceEndLocalDate ? { recurrenceEndLocalDate } : {}),
    recurrenceExcludedLocalDates: excludedLocalDates,
  };
}

function distinct<T>(values: readonly T[]): T[] {
  if (new Set(values).size !== values.length) throw new Error("recurrence values must be distinct");
  return [...values];
}
