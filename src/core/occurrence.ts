import type { OccurrenceStatus, TaskKind } from "./types.js";

const transitions: Readonly<Record<OccurrenceStatus, readonly OccurrenceStatus[]>> = {
  scheduled: ["open", "in_progress", "done", "skipped", "cancelled", "elapsed"],
  open: ["in_progress", "done", "skipped", "cancelled", "elapsed", "scheduled"],
  in_progress: ["done", "skipped", "cancelled", "open", "scheduled"],
  done: [],
  skipped: [],
  cancelled: [],
  elapsed: ["done"],
};

export interface TransitionContext {
  kind: TaskKind;
  recurring: boolean;
  now: Date;
  plannedStartAt?: Date;
  plannedEndAt?: Date;
  eventElapseGraceMinutes: number;
  explicitUserAction: boolean;
  systemExpire: boolean;
  isUndo?: boolean;
}

export function deriveInitialOccurrenceStatus(now: Date, plannedStartAt?: Date): "scheduled" | "open" {
  return plannedStartAt && plannedStartAt > now ? "scheduled" : "open";
}

export function validateOccurrenceTransition(
  from: OccurrenceStatus,
  to: OccurrenceStatus,
  context: TransitionContext,
): { ok: true } | { ok: false; reason: string } {
  if (context.isUndo) return { ok: true };
  if (!transitions[from].includes(to)) return { ok: false, reason: `illegal transition ${from} -> ${to}` };

  if (to === "skipped") {
    if (context.kind !== "task" || !context.recurring || (!context.explicitUserAction && !context.systemExpire)) {
      return { ok: false, reason: "skip is only valid for recurring tasks" };
    }
  }

  if (to === "elapsed") {
    if (context.kind !== "event") return { ok: false, reason: "only events become elapsed" };
    const boundary = context.plannedEndAt ?? context.plannedStartAt;
    if (!boundary) return { ok: false, reason: "event boundary is required" };
    const graceMs = context.eventElapseGraceMinutes * 60_000;
    if (context.now.getTime() < boundary.getTime() + graceMs) {
      return { ok: false, reason: "event grace period has not passed" };
    }
  }

  if (to === "cancelled" && !context.explicitUserAction) {
    return { ok: false, reason: "cancel requires explicit user action" };
  }

  return { ok: true };
}
