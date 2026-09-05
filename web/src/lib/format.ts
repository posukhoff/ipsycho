import type { Locale } from "../api/contracts.js";

/**
 * Rendering time, and nothing else.
 *
 * The contract's rule (primitives.ts) is that an instant crosses the wire as UTC and a local day
 * crosses as `YYYY-MM-DD` in the timezone the row already carries. So this file never *derives* a
 * day from an instant using the device clock — it formats an instant **in the row's own timezone**,
 * which is the only way a task dated «today» in Kyiv keeps that date on a phone set to UTC-5.
 *
 * `todayLocalDate` always comes from the server (`/me`, and again on every list response). Nothing
 * here asks the device what day it is.
 */

const INTL_LOCALE: Record<Locale, string> = { ru: "ru-RU", uk: "uk-UA", en: "en-GB" };

export function intlLocale(locale: Locale): string {
  return INTL_LOCALE[locale];
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function timeFormatter(locale: Locale, timezone: string): Intl.DateTimeFormat {
  const key = `${locale}|${timezone}`;
  const existing = timeFormatters.get(key);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone });
  timeFormatters.set(key, created);
  return created;
}

function dateFormatter(locale: Locale, timezone: string, withYear: boolean): Intl.DateTimeFormat {
  const key = `${locale}|${timezone}|${withYear}`;
  const existing = dateFormatters.get(key);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: timezone });
  dateFormatters.set(key, created);
  return created;
}

/** `2026-09-05T07:30:00.000Z` → `10:30` in `Europe/Kyiv`. */
export function formatInstantTime(instant: string, timezone: string, locale: Locale): string {
  return timeFormatter(locale, timezone).format(new Date(instant));
}

/** `2026-09-05` → `5 сент.`, with the year only when it is not the current one. */
export function formatLocalDate(localDate: string, locale: Locale, options: { todayLocalDate?: string } = {}): string {
  const sameYear = options.todayLocalDate ? options.todayLocalDate.slice(0, 4) === localDate.slice(0, 4) : true;
  // Noon UTC: far enough from either midnight that the formatter's own zone cannot move the day.
  return dateFormatter(locale, "UTC", !sameYear).format(new Date(`${localDate}T12:00:00.000Z`));
}

/** The day an instant falls on, in the given timezone, as `YYYY-MM-DD`. Used to group a list. */
export function instantToLocalDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: timezone }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export type DayOffset = "today" | "tomorrow" | "yesterday" | "other";

/** Which of «сегодня», «завтра», «вчера» a local day is, relative to the server's local today. */
export function dayOffset(localDate: string, todayLocalDate: string): DayOffset {
  if (localDate === todayLocalDate) return "today";
  if (localDate === shiftLocalDate(todayLocalDate, 1)) return "tomorrow";
  if (localDate === shiftLocalDate(todayLocalDate, -1)) return "yesterday";
  return "other";
}

/** Calendar arithmetic on a `YYYY-MM-DD`, done in UTC so no timezone can shift the result. */
export function shiftLocalDate(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 1 is Monday, 7 is Sunday — the same numbering as `weeklyReviewWeekday`. */
export function isoWeekday(localDate: string): number {
  const day = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function formatWeekday(localDate: string, locale: Locale, style: "short" | "long" = "short"): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: style, timeZone: "UTC" }).format(new Date(`${localDate}T12:00:00.000Z`));
}

/** `10:00 – 11:30`, collapsing to a single time when there is no end. */
export function formatTimeRange(startInstant: string | null, endInstant: string | null, timezone: string, locale: Locale): string {
  if (!startInstant) return endInstant ? formatInstantTime(endInstant, timezone, locale) : "";
  const start = formatInstantTime(startInstant, timezone, locale);
  if (!endInstant) return start;
  return `${start}–${formatInstantTime(endInstant, timezone, locale)}`;
}

/** Minutes between two instants, for a window's duration field in the create form. */
export function minutesBetween(startInstant: string, endInstant: string): number {
  return Math.round((new Date(endInstant).getTime() - new Date(startInstant).getTime()) / 60_000);
}

/** `13:05` plus 90 minutes, staying inside the day. Used by the duration control. */
export function addMinutesToLocalTime(localTime: string, minutes: number): string {
  const [hours = "0", mins = "0"] = localTime.split(":");
  const total = (Number(hours) * 60 + Number(mins) + minutes + 1440 * 7) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** The device's IANA zone, offered as the «detect» button on the timezone picker. Never assumed. */
export function detectTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** `+03:00` for a timezone suggestion's offset in minutes. */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}
