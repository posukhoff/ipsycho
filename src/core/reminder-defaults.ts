import type { Importance, ReminderTemplate, TaskKind, TimeMode } from "./types.js";

export interface ReminderDefaultPreferences {
  eventOffsetsMinutes?: readonly number[];
  plannedTaskOffsetMinutes?: number;
  criticalPostDueMinutes?: number;
  seenNormalMinutes?: number;
  seenRequiredMinutes?: number;
  seenCriticalMinutes?: number;
}

export function defaultReminderTemplates(
  input: {
    kind: TaskKind;
    timeMode: TimeMode;
    importance: Importance;
    hasPlannedStart: boolean;
  },
  preferences: ReminderDefaultPreferences = {},
): ReminderTemplate[] {
  const result: ReminderTemplate[] = [];

  if (input.kind === "event") {
    // An all-day event has no clock to count back from, so it takes the same morning-of contact an
    // all-day task takes; counting offsets from a start that does not exist threw and lost the task.
    if (!input.hasPlannedStart) {
      result.push({ kind: "local_date", anchor: "planned_start", daysOffset: 0, reference: "morning" });
      return result;
    }
    result.push(...(preferences.eventOffsetsMinutes ?? [-60, -15]).map((offsetMinutes) => ({ kind: "relative" as const, anchor: "planned_start" as const, offsetMinutes })));
    return result;
  }

  if (input.hasPlannedStart) {
    result.push({ kind: "relative", anchor: "planned_start", offsetMinutes: preferences.plannedTaskOffsetMinutes ?? 0 });
  }

  if (input.timeMode === "window" && !input.hasPlannedStart) {
    result.push({ kind: "local_date", anchor: "planned_start", daysOffset: 0, reference: "morning" });
  }

  if (input.timeMode === "deadline") {
    if (input.importance === "normal") {
      result.push({ kind: "local_date", anchor: "due_at", daysOffset: 0, reference: "morning" });
    } else if (input.importance === "required") {
      result.push(
        { kind: "local_date", anchor: "due_at", daysOffset: -1, reference: "evening" },
        { kind: "local_date", anchor: "due_at", daysOffset: 0, reference: "morning" },
        { kind: "local_date", anchor: "due_at", daysOffset: 0, reference: "evening", purpose: "follow_up" },
      );
    } else {
      result.push(
        { kind: "relative", anchor: "due_at", offsetMinutes: -180 },
        { kind: "relative", anchor: "due_at", offsetMinutes: -60 },
        { kind: "relative", anchor: "due_at", offsetMinutes: -30 },
        { kind: "relative", anchor: "due_at", offsetMinutes: -15 },
        { kind: "relative", anchor: "due_at", offsetMinutes: 0 },
        { kind: "relative", anchor: "due_at", offsetMinutes: preferences.criticalPostDueMinutes ?? 60, purpose: "follow_up" },
      );
    }
  }

  return result;
}

export function shouldMergeReminderContacts(a: Date, b: Date, minimumMinutes = 15): boolean {
  return Math.abs(a.getTime() - b.getTime()) < minimumMinutes * 60_000;
}

export function seenFollowUpMinutes(importance: Importance, preferences: ReminderDefaultPreferences = {}): number {
  if (importance === "critical") return preferences.seenCriticalMinutes ?? 15;
  if (importance === "required") return preferences.seenRequiredMinutes ?? 30;
  return preferences.seenNormalMinutes ?? 60;
}
