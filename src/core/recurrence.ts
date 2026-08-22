import { deriveInitialOccurrenceStatus } from "./occurrence.js";
import type { MissPolicy, OccurrenceStatus, TaskDefinition, TimeMode } from "./types.js";
import {
  compareLocalDates,
  daysBetweenLocalDates,
  formatLocalDate,
  localDateAndTimeToUtc,
  localDateAt,
  localDateTimeAt,
  parseLocalDate,
  parseLocalTime,
  shiftLocalDate,
  startOfLocalDateUtc,
} from "./timezone.js";

export interface RecurrenceRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  byDay?: readonly Weekday[];
  byMonthDay?: readonly number[];
  /** Explicit local times for each DAILY occurrence. */
  byTime?: readonly string[];
}

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface OccurrenceProjection {
  recurrenceKey?: string;
  status: OccurrenceStatus;
  timezone: string;
  plannedStartAt?: Date;
  plannedEndAt?: Date;
  plannedLocalDate?: string;
  dueAt?: Date;
  dueLocalDate?: string;
  expiresAt?: Date;
  dstAdjusted?: boolean;
}

const DAY_INDEX: Record<Weekday, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

function weekdayOf(localDate: string): Weekday {
  const { year, month, day } = parseLocalDate(localDate);
  const js = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const)[js] ?? "MO";
}

function monthIndex(localDate: string): number {
  const { year, month } = parseLocalDate(localDate);
  return year * 12 + month - 1;
}

function monthDate(monthValue: number, day: number): string | null {
  const year = Math.floor(monthValue / 12);
  const month = (monthValue % 12) + 1;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return formatLocalDate({ year, month, day });
}

export function parseRecurrenceRule(value: string): RecurrenceRule {
  const entries = value.split(";").filter(Boolean).map((part) => part.split("=", 2) as [string, string]);
  const map = new Map(entries);
  const allowed = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYTIME"]);
  for (const key of map.keys()) if (!allowed.has(key)) throw new Error(`unsupported recurrence field ${key}`);

  const freq = map.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") throw new Error("recurrence FREQ must be DAILY, WEEKLY or MONTHLY");
  const interval = map.has("INTERVAL") ? Number(map.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) throw new Error("recurrence INTERVAL must be a positive integer <= 365");

  const byDayValue = map.get("BYDAY");
  const byDay = byDayValue ? byDayValue.split(",") as Weekday[] : undefined;
  if (byDay && byDay.some((day) => !(day in DAY_INDEX))) throw new Error("invalid BYDAY value");
  if (byDay && freq !== "WEEKLY") throw new Error("BYDAY is supported only for WEEKLY recurrence");

  const byMonthDayValue = map.get("BYMONTHDAY");
  const byMonthDay = byMonthDayValue ? byMonthDayValue.split(",").map(Number) : undefined;
  if (byMonthDay && byMonthDay.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) throw new Error("invalid BYMONTHDAY value");
  if (byMonthDay && freq !== "MONTHLY") throw new Error("BYMONTHDAY is supported only for MONTHLY recurrence");

  const byTimeValue = map.get("BYTIME");
  const byTime = map.has("BYTIME") ? byTimeValue?.split(",") : undefined;
  if (byTime) {
    if (!byTimeValue || !byTime.length || byTime.some((time) => !/^\d{2}:\d{2}$/.test(time))) throw new Error("invalid BYTIME value");
    for (const time of byTime) parseLocalTime(time);
    if (new Set(byTime).size !== byTime.length) throw new Error("BYTIME values must be distinct");
  }
  if (byTime && freq !== "DAILY") throw new Error("BYTIME is supported only for DAILY recurrence");
  const sortedByTime = byTime?.slice().sort();

  return {
    freq,
    interval,
    ...(byDay ? { byDay } : {}),
    ...(byMonthDay ? { byMonthDay } : {}),
    ...(sortedByTime ? { byTime: sortedByTime } : {}),
  };
}

function recurrenceDates(seed: string, rule: RecurrenceRule, through: string): string[] {
  const result: string[] = [];

  if (rule.freq === "DAILY") {
    for (let cursor = seed; compareLocalDates(cursor, through) <= 0; cursor = shiftLocalDate(cursor, rule.interval)) result.push(cursor);
    return result;
  }

  if (rule.freq === "WEEKLY") {
    const seedWeekday = DAY_INDEX[weekdayOf(seed)];
    const monday = shiftLocalDate(seed, -(seedWeekday - 1));
    const days = (rule.byDay ?? [weekdayOf(seed)]).slice().sort((a, b) => DAY_INDEX[a] - DAY_INDEX[b]);
    for (let week = 0; ; week += rule.interval) {
      const base = shiftLocalDate(monday, week * 7);
      if (compareLocalDates(base, through) > 0) break;
      for (const day of days) {
        const candidate = shiftLocalDate(base, DAY_INDEX[day] - 1);
        if (compareLocalDates(candidate, seed) >= 0 && compareLocalDates(candidate, through) <= 0) result.push(candidate);
      }
    }
    return result;
  }

  const seedParts = parseLocalDate(seed);
  const days = rule.byMonthDay ?? [seedParts.day];
  const startMonth = monthIndex(seed);
  const endMonth = monthIndex(through);
  for (let month = startMonth; month <= endMonth; month += rule.interval) {
    for (const day of days) {
      const candidate = monthDate(month, day);
      if (candidate && compareLocalDates(candidate, seed) >= 0 && compareLocalDates(candidate, through) <= 0) result.push(candidate);
    }
  }
  return result.sort();
}

function recurrenceAnchorLocalDate(task: TaskDefinition, timezone: string): string {
  if (task.timeMode === "point" || task.timeMode === "window") {
    if (task.plannedStartAt) return localDateAt(task.plannedStartAt, timezone);
    if (task.plannedLocalDate) return task.plannedLocalDate;
  }
  if (task.timeMode === "deadline") {
    if (task.dueAt) return localDateAt(task.dueAt, timezone);
    if (task.dueLocalDate) return task.dueLocalDate;
  }
  throw new Error("recurring task has no materializable anchor");
}

function localTimeString(date: Date, timezone: string): string {
  const parts = localDateTimeAt(date, timezone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function projectExactField(base: Date, anchorDate: string, targetDate: string, timezone: string): { value: Date; adjusted: boolean } {
  const baseLocalDate = localDateAt(base, timezone);
  const offsetDays = daysBetweenLocalDates(anchorDate, baseLocalDate);
  const localDate = shiftLocalDate(targetDate, offsetDays);
  const mapped = localDateAndTimeToUtc(localDate, localTimeString(base, timezone), timezone);
  return { value: mapped.date, adjusted: mapped.dstAdjusted };
}

function dueBoundaryForLocalDate(localDate: string, timezone: string): Date {
  return startOfLocalDateUtc(shiftLocalDate(localDate, 1), timezone).date;
}

function primaryStart(projection: OccurrenceProjection): Date | undefined {
  return projection.plannedStartAt;
}

function statusForProjection(projection: OccurrenceProjection, now: Date): "scheduled" | "open" {
  if (projection.plannedStartAt) return deriveInitialOccurrenceStatus(now, projection.plannedStartAt);
  if (projection.plannedLocalDate) return compareLocalDates(projection.plannedLocalDate, localDateAt(now, projection.timezone)) > 0 ? "scheduled" : "open";
  if (projection.recurrenceKey) return compareLocalDates(projection.recurrenceKey, localDateAt(now, projection.timezone)) > 0 ? "scheduled" : "open";
  return "open";
}

function buildProjectionForDate(
  task: TaskDefinition,
  targetDate: string,
  anchorDate: string,
  timezone: string,
  occurrenceTime?: string,
): OccurrenceProjection {
  let dstAdjusted = false;
  const projection: OccurrenceProjection = {
    status: "open",
    timezone,
    recurrenceKey: occurrenceTime ? `${targetDate}T${occurrenceTime}` : targetDate,
  };

  if (task.plannedStartAt && occurrenceTime) {
    const mapped = localDateAndTimeToUtc(targetDate, occurrenceTime, timezone);
    projection.plannedStartAt = mapped.date;
    dstAdjusted ||= mapped.dstAdjusted;
    if (task.plannedEndAt) projection.plannedEndAt = new Date(mapped.date.getTime() + task.plannedEndAt.getTime() - task.plannedStartAt.getTime());
  } else if (task.plannedStartAt) {
    const mapped = projectExactField(task.plannedStartAt, anchorDate, targetDate, timezone);
    projection.plannedStartAt = mapped.value;
    dstAdjusted ||= mapped.adjusted;
  }
  if (task.plannedEndAt && !occurrenceTime) {
    const mapped = projectExactField(task.plannedEndAt, anchorDate, targetDate, timezone);
    projection.plannedEndAt = mapped.value;
    dstAdjusted ||= mapped.adjusted;
  }
  if (task.plannedLocalDate) {
    const offset = daysBetweenLocalDates(anchorDate, task.plannedLocalDate);
    projection.plannedLocalDate = shiftLocalDate(targetDate, offset);
  }
  if (task.dueAt) {
    const mapped = projectExactField(task.dueAt, anchorDate, targetDate, timezone);
    projection.dueAt = mapped.value;
    dstAdjusted ||= mapped.adjusted;
  }
  if (task.dueLocalDate) {
    const offset = daysBetweenLocalDates(anchorDate, task.dueLocalDate);
    projection.dueLocalDate = shiftLocalDate(targetDate, offset);
  }
  if (dstAdjusted) projection.dstAdjusted = true;
  return projection;
}

function applyExpiry(projection: OccurrenceProjection, missPolicy: MissPolicy | undefined, nextProjection?: OccurrenceProjection): void {
  if (missPolicy !== "expire") return;
  if (projection.plannedEndAt) projection.expiresAt = projection.plannedEndAt;
  else if (projection.dueAt) projection.expiresAt = projection.dueAt;
  else if (projection.dueLocalDate) projection.expiresAt = dueBoundaryForLocalDate(projection.dueLocalDate, projection.timezone);
  else if (projection.plannedStartAt && nextProjection?.plannedStartAt) projection.expiresAt = nextProjection.plannedStartAt;
}

export function buildOneTimeOccurrence(task: TaskDefinition, now: Date): OccurrenceProjection | null {
  if (task.timeMode === "fuzzy") return null;
  const projection: OccurrenceProjection = {
    status: "open",
    timezone: task.timezone,
    ...(task.plannedStartAt ? { plannedStartAt: task.plannedStartAt } : {}),
    ...(task.plannedEndAt ? { plannedEndAt: task.plannedEndAt } : {}),
    ...(task.plannedLocalDate ? { plannedLocalDate: task.plannedLocalDate } : {}),
    ...(task.dueAt ? { dueAt: task.dueAt } : {}),
    ...(task.dueLocalDate ? { dueLocalDate: task.dueLocalDate } : {}),
  };
  projection.status = statusForProjection(projection, now);
  return projection;
}

export function buildRecurringOccurrences(task: TaskDefinition, now: Date, horizonDays = 30): OccurrenceProjection[] {
  if (!task.recurrenceRule) throw new Error("recurrenceRule is required");
  if (task.timeMode === "fuzzy") throw new Error("fuzzy recurrence is not materializable");
  const timezone = task.recurrenceTimezone ?? task.timezone;
  const rule = parseRecurrenceRule(task.recurrenceRule);
  if (rule.byTime && (!task.plannedStartAt || (task.timeMode !== "point" && task.timeMode !== "window"))) {
    throw new Error("BYTIME requires a point or window recurrence with plannedStartAt");
  }
  const seed = recurrenceAnchorLocalDate(task, timezone);
  const seedTime = rule.byTime && task.plannedStartAt ? localTimeString(task.plannedStartAt, timezone) : undefined;
  if (rule.byTime && seedTime && !rule.byTime.includes(seedTime)) {
    throw new Error("plannedStartAt time must be included in BYTIME");
  }
  const today = localDateAt(now, timezone);
  const horizon = shiftLocalDate(today, horizonDays);

  // Generate only far enough past the visible window to know the next expiry boundary.
  // Daily/weekly gaps are exact; monthly keeps a wider bound because dates such as Feb 29
  // or day 31 may skip calendar months.
  const extensionDays = rule.freq === "DAILY"
    ? rule.interval
    : rule.freq === "WEEKLY"
      ? rule.interval * 7
      : 370 * rule.interval;
  const extension = shiftLocalDate(horizon, extensionDays);
  const dates = recurrenceDates(seed, rule, extension);
  const visible = dates.filter((date) => compareLocalDates(date, horizon) <= 0 && compareLocalDates(date, today) >= 0);
  if (!visible.length && compareLocalDates(seed, horizon) <= 0 && compareLocalDates(seed, today) < 0) {
    // No candidate in the initial extension should be rare; keep the result empty instead of projecting outside the 30-day window.
    return [];
  }

  const slots = dates.flatMap((date) => (rule.byTime ?? [undefined])
    .filter((time) => date !== seed || !time || !seedTime || time >= seedTime)
    .map((time) => ({ date, time })));
  const projections = slots.map(({ date, time }) => buildProjectionForDate(task, date, seed, timezone, time));
  const result: OccurrenceProjection[] = [];
  for (let i = 0; i < projections.length; i += 1) {
    const projection = projections[i];
    if (!projection) continue;
    const date = slots[i]?.date;
    if (!date || compareLocalDates(date, today) < 0 || compareLocalDates(date, horizon) > 0) continue;
    const next = projections[i + 1];
    applyExpiry(projection, task.missPolicy, next);
    projection.status = statusForProjection(projection, now);
    result.push(projection);
  }
  // A deadline-only recurring task has one current obligation available immediately,
  // while later materialized recurrences stay scheduled until their recurrence date.
  if (task.timeMode === "deadline" && !task.plannedStartAt && !task.plannedLocalDate && result[0]) result[0].status = "open";
  return result;
}

export function projectionAnchor(projection: OccurrenceProjection, mode: TimeMode): Date | undefined {
  if (mode === "deadline") return projection.dueAt ?? primaryStart(projection);
  return primaryStart(projection);
}
