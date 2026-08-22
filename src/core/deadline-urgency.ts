import { localDateAndTimeToUtc } from "./timezone.js";

export type DeadlineUrgency = "normal" | "watch" | "high" | "urgent" | "overdue";

export function deadlineUrgency(input: { dueAt?: Date | null; dueLocalDate?: string | null; timezone: string; now: Date }): DeadlineUrgency | null {
  const deadline = input.dueAt ?? (input.dueLocalDate ? localDateAndTimeToUtc(input.dueLocalDate, "23:59", input.timezone).date : undefined);
  if (!deadline) return null;
  const hours = (deadline.getTime() - input.now.getTime()) / 3_600_000;
  if (hours < 0) return "overdue";
  if (hours <= 72) return "urgent";
  if (hours <= 7 * 24) return "high";
  if (hours <= 14 * 24) return "watch";
  return "normal";
}
