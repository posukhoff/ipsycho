import { localDateAndTimeToUtc, localDateAt, localDateTimeAt, shiftLocalDate } from "./timezone.js";
import type { TimeMode } from "./types.js";

export type QuickRescheduleChoice = "1h" | "evening" | "tomorrow";

export interface QuickRescheduleOccurrence {
  timezone: string;
  plannedStartAt?: Date | null;
  plannedEndAt?: Date | null;
  plannedLocalDate?: string | null;
  dueAt?: Date | null;
  dueLocalDate?: string | null;
}

export interface QuickRescheduleSchedule {
  plannedStartAt?: Date;
  plannedEndAt?: Date;
  plannedLocalDate?: string;
  dueAt?: Date;
  dueLocalDate?: string;
}

export function quickRescheduleSchedule(input: {
  choice: QuickRescheduleChoice;
  timeMode: TimeMode;
  occurrence: QuickRescheduleOccurrence;
  now: Date;
  morningReferenceTime?: string;
  eveningReferenceTime?: string;
}): QuickRescheduleSchedule {
  const timezone = input.occurrence.timezone;
  const morning = input.morningReferenceTime ?? "09:00";
  const evening = input.eveningReferenceTime ?? "20:00";

  if (input.choice === "1h") {
    const target = new Date(input.now.getTime() + 60 * 60_000);
    return scheduleAt(target, input.timeMode, input.occurrence);
  }

  if (input.choice === "evening") {
    const today = localDateAt(input.now, timezone);
    let target = localDateAndTimeToUtc(today, evening, timezone).date;
    if (target <= input.now) target = localDateAndTimeToUtc(shiftLocalDate(today, 1), evening, timezone).date;
    return scheduleAt(target, input.timeMode, input.occurrence);
  }

  const tomorrow = shiftLocalDate(localDateAt(input.now, timezone), 1);
  if (input.timeMode === "deadline" && !input.occurrence.dueAt) return { dueLocalDate: tomorrow };
  if (input.timeMode === "window" && !input.occurrence.plannedStartAt && input.occurrence.plannedLocalDate) return { plannedLocalDate: tomorrow };
  if (input.timeMode === "point" && !input.occurrence.plannedStartAt && input.occurrence.plannedLocalDate) return { plannedLocalDate: tomorrow };

  const source = input.timeMode === "deadline"
    ? input.occurrence.dueAt
    : input.occurrence.plannedStartAt;
  const localTime = source ? formatLocalTime(source, timezone) : morning;
  const target = localDateAndTimeToUtc(tomorrow, localTime, timezone).date;
  return scheduleAt(target, input.timeMode, input.occurrence);
}

function scheduleAt(target: Date, timeMode: TimeMode, occurrence: QuickRescheduleOccurrence): QuickRescheduleSchedule {
  if (timeMode === "deadline") return { dueAt: target };
  if (timeMode === "window") {
    const duration = occurrence.plannedStartAt && occurrence.plannedEndAt
      ? Math.max(15 * 60_000, occurrence.plannedEndAt.getTime() - occurrence.plannedStartAt.getTime())
      : 60 * 60_000;
    return { plannedStartAt: target, plannedEndAt: new Date(target.getTime() + duration) };
  }
  return { plannedStartAt: target };
}

function formatLocalTime(at: Date, timezone: string): string {
  const local = localDateTimeAt(at, timezone);
  return `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
}

export function compactText(value: string, max = 500): string {
  const normalized = value.replace(/\n{3,}/gu, "\n\n").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
