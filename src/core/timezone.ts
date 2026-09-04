export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface ZonedDateTimeResult {
  date: Date;
  dstAdjusted: boolean;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, value);
  }
  return value;
}

function partMap(at: Date, timezone: string): Map<string, string> {
  return new Map(
    formatter(timezone)
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
}

export function localDateTimeAt(at: Date, timezone: string): LocalDateTime {
  const parts = partMap(at, timezone);
  const read = (name: string): number => {
    const value = Number(parts.get(name));
    if (!Number.isInteger(value)) throw new Error(`cannot resolve ${name} in timezone ${timezone}`);
    return value;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

export function formatLocalDate(parts: Pick<LocalDateTime, "year" | "month" | "day">): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function localDateAt(at: Date, timezone: string): string {
  return formatLocalDate(localDateTimeAt(at, timezone));
}

export function parseLocalDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`invalid local date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`invalid local date: ${value}`);
  }
  return { year, month, day };
}

export function parseLocalTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`invalid local time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`invalid local time: ${value}`);
  return { hour, minute };
}

export function shiftLocalDate(value: string, days: number): string {
  const { year, month, day } = parseLocalDate(value);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatLocalDate({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() });
}

export function compareLocalDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function daysBetweenLocalDates(a: string, b: string): number {
  const pa = parseLocalDate(a);
  const pb = parseLocalDate(b);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86_400_000);
}

function scalar(parts: LocalDateTime): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function sameLocal(a: LocalDateTime, b: LocalDateTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

/**
 * Converts a local wall-clock time in an IANA timezone to UTC.
 * Ambiguous fall-back times choose the first occurrence. Nonexistent spring-forward
 * times move forward to the first representable local minute, matching the baseline.
 */
export function localDateTimeToUtc(parts: LocalDateTime, timezone: string): ZonedDateTimeResult {
  const naive = scalar(parts);
  let candidate = naive;

  for (let i = 0; i < 4; i += 1) {
    const actual = localDateTimeAt(new Date(candidate), timezone);
    candidate += naive - scalar(actual);
  }

  const exact: number[] = [];
  const second = parts.second;
  const alignSecond = (value: number): number => {
    const date = new Date(value);
    return value - (date.getUTCSeconds() - second) * 1_000 - date.getUTCMilliseconds();
  };

  // Normal dates are resolved by the offset iteration above. Check only nearby
  // offset alternatives first; the minute scan is reserved for DST gaps.
  for (const delta of [0, -60, 60, -120, 120].map((minutes) => minutes * 60_000)) {
    const aligned = alignSecond(candidate + delta);
    const actual = localDateTimeAt(new Date(aligned), timezone);
    if (sameLocal(actual, parts)) exact.push(aligned);
  }
  if (exact.length) return { date: new Date(Math.min(...exact)), dstAdjusted: false };

  const searchStart = candidate - 4 * 60 * 60_000;
  const searchEnd = candidate + 4 * 60 * 60_000;
  const targetDate = formatLocalDate(parts);
  const targetScalar = scalar(parts);
  let best: { value: number; delta: number } | undefined;
  for (let value = searchStart; value <= searchEnd; value += 60_000) {
    const actual = localDateTimeAt(new Date(value), timezone);
    if (formatLocalDate(actual) !== targetDate) continue;
    const delta = scalar(actual) - targetScalar;
    if (delta < 0) continue;
    if (!best || delta < best.delta || (delta === best.delta && value < best.value)) best = { value, delta };
  }
  if (!best) throw new Error(`cannot map local time ${targetDate} ${parts.hour}:${parts.minute} in ${timezone}`);
  return { date: new Date(best.value), dstAdjusted: true };
}

export function localDateAndTimeToUtc(localDate: string, localTime: string, timezone: string): ZonedDateTimeResult {
  const date = parseLocalDate(localDate);
  const time = parseLocalTime(localTime);
  return localDateTimeToUtc({ ...date, ...time, second: 0 }, timezone);
}

export function startOfLocalDateUtc(localDate: string, timezone: string): ZonedDateTimeResult {
  return localDateAndTimeToUtc(localDate, "00:00", timezone);
}

export function formatIsoInstantInTimezone(at: Date, timezone: string): string {
  const local = localDateTimeAt(at, timezone);
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const minuteAligned = Math.floor(at.getTime() / 1000) * 1000;
  const offsetMinutes = Math.round((localAsUtc - minuteAligned) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hh = String(Math.floor(absolute / 60)).padStart(2, "0");
  const mm = String(absolute % 60).padStart(2, "0");
  return `${formatLocalDate(local)}T${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}:${String(local.second).padStart(2, "0")}${sign}${hh}:${mm}`;
}
