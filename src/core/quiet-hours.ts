import type { QuietHours } from "./types.js";

const formatters = new Map<string, Intl.DateTimeFormat>();

function minutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`invalid HH:mm value: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`invalid HH:mm value: ${value}`);
  return hour * 60 + minute;
}

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, value);
  }
  return value;
}

function localParts(at: Date, timezone: string): { weekday: string; minuteOfDay: number } {
  const parts = formatter(timezone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const weekday = get("weekday");
  if (!weekday || Number.isNaN(hour) || Number.isNaN(minute)) throw new Error(`cannot resolve local time for ${timezone}`);
  return { weekday, minuteOfDay: hour * 60 + minute };
}

export function isMinuteInsideRange(value: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return value >= start && value < end;
  return value >= start || value < end;
}

export function isQuietAt(at: Date, timezone: string, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false;
  const local = localParts(at, timezone);
  const weekend = local.weekday === "Sat" || local.weekday === "Sun";
  const range = weekend ? quiet.weekend : quiet.weekday;
  return isMinuteInsideRange(local.minuteOfDay, minutes(range.start), minutes(range.end));
}
