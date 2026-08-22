import { buildOneTimeOccurrence } from "./recurrence.js";
import { validateTaskDefinition } from "./task-policy.js";
import type { TaskDefinition } from "./types.js";

export interface RescheduleFields {
  plannedStartAt?: Date;
  plannedEndAt?: Date;
  plannedLocalDate?: string;
  dueAt?: Date;
  dueLocalDate?: string;
  fuzzyHorizonText?: string;
  reviewAt?: Date;
}

export function rescheduledDefinition(current: TaskDefinition, schedule: RescheduleFields): TaskDefinition {
  const {
    plannedStartAt: _plannedStartAt, plannedEndAt: _plannedEndAt, plannedLocalDate: _plannedLocalDate,
    dueAt: _dueAt, dueLocalDate: _dueLocalDate, fuzzyHorizonText: _fuzzyHorizonText, reviewAt: _reviewAt,
    ...stable
  } = current;
  const becomesFuzzy = Boolean(schedule.fuzzyHorizonText || schedule.reviewAt);
  const next: TaskDefinition = {
    ...stable,
    timeMode: becomesFuzzy ? "fuzzy" : current.timeMode,
    ...(schedule.plannedStartAt ? { plannedStartAt: schedule.plannedStartAt } : {}),
    ...(schedule.plannedEndAt ? { plannedEndAt: schedule.plannedEndAt } : {}),
    ...(schedule.plannedLocalDate ? { plannedLocalDate: schedule.plannedLocalDate } : {}),
    ...(schedule.dueAt ? { dueAt: schedule.dueAt } : {}),
    ...(schedule.dueLocalDate ? { dueLocalDate: schedule.dueLocalDate } : {}),
    ...(schedule.fuzzyHorizonText ? { fuzzyHorizonText: schedule.fuzzyHorizonText } : {}),
    ...(schedule.reviewAt ? { reviewAt: schedule.reviewAt } : {}),
  };
  const validation = validateTaskDefinition(next);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return next;
}

export function rescheduledOccurrenceStatus(definition: TaskDefinition, now: Date): "scheduled" | "open" {
  const { recurrenceRule: _rule, recurrenceTimezone: _tz, missPolicy: _miss, ...oneTime } = definition;
  const projection = buildOneTimeOccurrence(oneTime, now);
  if (!projection) throw new Error("fuzzy tasks do not have reschedulable occurrences");
  if (projection.status !== "scheduled" && projection.status !== "open") throw new Error("unexpected rescheduled occurrence status");
  return projection.status;
}
