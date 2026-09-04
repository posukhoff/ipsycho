import type { MissPolicy, OccurrenceStatus, TaskKind, TimeMode } from "./types.js";
import { compareLocalDates, localDateAt } from "./timezone.js";

export interface LifecycleInput {
  kind: TaskKind;
  timeMode: TimeMode;
  recurring: boolean;
  missPolicy?: MissPolicy;
  status: OccurrenceStatus;
  timezone: string;
  now: Date;
  plannedStartAt?: Date;
  plannedEndAt?: Date;
  plannedLocalDate?: string;
  recurrenceKey?: string;
  dueAt?: Date;
  dueLocalDate?: string;
  expiresAt?: Date;
  overdue: boolean;
  eventElapseGraceMinutes: number;
}

export interface LifecycleDecision {
  transitionTo?: "open" | "skipped" | "elapsed";
  markOverdue?: boolean;
}

const TERMINAL = new Set<OccurrenceStatus>(["done", "skipped", "cancelled", "elapsed"]);

export function evaluateOccurrenceLifecycle(input: LifecycleInput): LifecycleDecision {
  if (TERMINAL.has(input.status)) return {};

  if (input.kind === "task" && input.recurring && input.missPolicy === "expire" && input.expiresAt && input.now >= input.expiresAt) {
    return { transitionTo: "skipped" };
  }

  if (input.kind === "event" && (input.status === "scheduled" || input.status === "open")) {
    const boundary = input.plannedEndAt ?? input.plannedStartAt;
    if (boundary && input.now.getTime() >= boundary.getTime() + input.eventElapseGraceMinutes * 60_000) {
      return { transitionTo: "elapsed" };
    }
  }

  if (input.status === "scheduled") {
    if (input.plannedStartAt && input.plannedStartAt <= input.now) return { transitionTo: "open" };
    if (input.plannedLocalDate && compareLocalDates(input.plannedLocalDate, localDateAt(input.now, input.timezone)) <= 0) {
      return { transitionTo: "open" };
    }
    if (!input.plannedStartAt && !input.plannedLocalDate && input.recurrenceKey && compareLocalDates(input.recurrenceKey, localDateAt(input.now, input.timezone)) <= 0) {
      return { transitionTo: "open" };
    }
  }

  if (input.kind === "task" && input.timeMode === "deadline" && !input.overdue) {
    if (input.dueAt && input.now >= input.dueAt) return { markOverdue: true };
    if (input.dueLocalDate && compareLocalDates(localDateAt(input.now, input.timezone), input.dueLocalDate) > 0) {
      return { markOverdue: true };
    }
  }

  return {};
}
