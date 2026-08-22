export type TaskKind = "task" | "event";
export type Importance = "normal" | "required" | "critical";
export type TaskStatus = "active" | "paused" | "closed" | "cancelled";
export type TimeMode = "point" | "window" | "deadline" | "fuzzy";
export type OccurrenceStatus = "scheduled" | "open" | "in_progress" | "done" | "skipped" | "cancelled" | "elapsed";
export type MissPolicy = "expire" | "carry_over";

export interface TaskDefinition {
  kind: TaskKind;
  importance: Importance;
  timeMode: TimeMode;
  timezone: string;
  plannedStartAt?: Date;
  plannedEndAt?: Date;
  plannedLocalDate?: string;
  dueAt?: Date;
  dueLocalDate?: string;
  fuzzyHorizonText?: string;
  reviewAt?: Date;
  recurrenceRule?: string;
  recurrenceTimezone?: string;
  recurrenceEndLocalDate?: string;
  recurrenceExcludedLocalDates?: readonly string[];
  missPolicy?: MissPolicy;
  habitMode?: boolean;
  minimumAction?: string;
  desiredAction?: string;
  habitTrigger?: string;
}

export interface QuietHours {
  enabled: boolean;
  weekday: { start: string; end: string };
  weekend: { start: string; end: string };
}

export type ReminderTemplate =
  | {
      kind: "relative";
      anchor: "planned_start" | "planned_end" | "due_at" | "review_at";
      offsetMinutes: number;
      purpose?: "user_reminder" | "follow_up" | "planning_review";
    }
  | {
      kind: "local_date";
      anchor: "planned_start" | "due_at";
      daysOffset: number;
      reference: "morning" | "evening";
      purpose?: "user_reminder" | "follow_up" | "planning_review";
    };
