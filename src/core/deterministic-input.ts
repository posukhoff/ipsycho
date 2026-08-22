import { localDateAndTimeToUtc, localDateAt, parseLocalDate, parseLocalTime, shiftLocalDate } from "./timezone.js";
import type { RescheduleFields } from "./reschedule.js";
import type { TimeMode } from "./types.js";

export interface ParsedRescheduleInput {
  schedule: RescheduleFields;
  reason?: string;
}

export function splitReason(value: string): { body: string; reason?: string } {
  const [body, ...reasonParts] = value.split("|");
  const normalizedBody = body?.trim() ?? "";
  const reason = reasonParts.join("|").trim();
  return { body: normalizedBody, ...(reason ? { reason } : {}) };
}

export function parseRescheduleInput(
  value: string,
  timeMode: TimeMode,
  timezone: string,
): ParsedRescheduleInput {
  const { body, reason } = splitReason(value);
  if (!body) throw new Error("new schedule is required");

  if (/^(?:fuzzy|неопредел[её]нно|примерно)\s*:/iu.test(body)) {
    const raw = body.replace(/^(?:fuzzy|неопредел[её]нно|примерно)\s*:/iu, "").trim();
    const match = /^(.*?)\s*@\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/u.exec(raw);
    if (!match?.[1] || !match[2] || !match[3]) throw new Error("fuzzy format must be: примерно: <горизонт> @ YYYY-MM-DD HH:MM");
    parseLocalDate(match[2]);
    parseLocalTime(match[3]);
    const reviewAt = localDateAndTimeToUtc(match[2], match[3], timezone).date;
    return { schedule: { fuzzyHorizonText: match[1].trim(), reviewAt }, ...(reason ? { reason } : {}) };
  }

  if (timeMode === "window") {
    const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/u.exec(body);
    if (!match?.[1] || !match[2] || !match[3]) throw new Error("window format must be YYYY-MM-DD HH:MM-HH:MM");
    parseLocalDate(match[1]); parseLocalTime(match[2]); parseLocalTime(match[3]);
    const start = localDateAndTimeToUtc(match[1], match[2], timezone).date;
    let endDate = match[1];
    let end = localDateAndTimeToUtc(endDate, match[3], timezone).date;
    if (end <= start) {
      endDate = shiftLocalDate(endDate, 1);
      end = localDateAndTimeToUtc(endDate, match[3], timezone).date;
    }
    return { schedule: { plannedStartAt: start, plannedEndAt: end }, ...(reason ? { reason } : {}) };
  }

  if (timeMode === "deadline") {
    const dateOnly = /^(\d{4}-\d{2}-\d{2})$/u.exec(body);
    if (dateOnly?.[1]) {
      parseLocalDate(dateOnly[1]);
      return { schedule: { dueLocalDate: dateOnly[1] }, ...(reason ? { reason } : {}) };
    }
    const exact = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/u.exec(body);
    if (!exact?.[1] || !exact[2]) throw new Error("deadline format must be YYYY-MM-DD or YYYY-MM-DD HH:MM");
    parseLocalDate(exact[1]); parseLocalTime(exact[2]);
    return { schedule: { dueAt: localDateAndTimeToUtc(exact[1], exact[2], timezone).date }, ...(reason ? { reason } : {}) };
  }

  // point and fuzzy tasks can both be concretized to one point.
  const point = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/u.exec(body);
  if (!point?.[1] || !point[2]) throw new Error("point format must be YYYY-MM-DD HH:MM");
  parseLocalDate(point[1]); parseLocalTime(point[2]);
  return { schedule: { plannedStartAt: localDateAndTimeToUtc(point[1], point[2], timezone).date }, ...(reason ? { reason } : {}) };
}

export function parseCustomFollowUpInput(value: string, timezone: string, now: Date): Date {
  const normalized = value.trim();
  if (/^\d{1,4}$/u.test(normalized)) {
    const minutes = Number(normalized);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 7 * 24 * 60) throw new Error("minutes must be between 15 and 10080");
    return new Date(now.getTime() + minutes * 60_000);
  }
  if (/^\d{2}:\d{2}$/u.test(normalized)) {
    parseLocalTime(normalized);
    const today = localDateAt(now, timezone);
    let target = localDateAndTimeToUtc(today, normalized, timezone).date;
    if (target <= now) target = localDateAndTimeToUtc(shiftLocalDate(today, 1), normalized, timezone).date;
    return target;
  }
  const exact = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/u.exec(normalized);
  if (!exact?.[1] || !exact[2]) throw new Error("custom time must be minutes, HH:MM, or YYYY-MM-DD HH:MM");
  parseLocalDate(exact[1]); parseLocalTime(exact[2]);
  const target = localDateAndTimeToUtc(exact[1], exact[2], timezone).date;
  if (target <= now) throw new Error("custom time must be in the future");
  return target;
}
