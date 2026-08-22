import type { QuietHours, ReminderTemplate, TaskDefinition } from "./types.js";
import type { OccurrenceProjection } from "./recurrence.js";
import { isQuietAt } from "./quiet-hours.js";
import { localDateAndTimeToUtc, localDateAt, shiftLocalDate } from "./timezone.js";

export type ReminderTriggerKind = "exact" | "relative_timestamp" | "local_date";
export type ReminderPurpose = "user_reminder" | "follow_up" | "planning_review";
export type QuietPolicy = "respect" | "bypass";
export type SuppressedReason = "quiet_stale" | "snooze_stale" | "no_longer_applicable";

/** Allows queue/rebuild latency without reviving genuinely stale reminders. */
export const IMMEDIATE_DELIVERY_GRACE_MS = 60_000;

export interface ReminderRuleSpec {
  triggerKind: ReminderTriggerKind;
  exactAt?: Date;
  anchor?: "planned_start" | "planned_end" | "due_at" | "review_at";
  offsetSeconds?: number;
  daysOffset?: number;
  localTime?: string;
  purpose: ReminderPurpose;
  quietPolicy: QuietPolicy;
  origin?: "default" | "explicit" | "system";
}

export interface ReminderSettings {
  notificationTimezone: string;
  quietHours: QuietHours;
  notificationsSnoozedUntil?: Date;
  morningReferenceTime: string;
  eveningReferenceTime: string;
}

export interface PlannedReminder {
  ruleIndex: number;
  intendedFor: Date;
  scheduledFor: Date;
  suppressedReason?: SuppressedReason;
}

function ruleFromTemplate(template: ReminderTemplate, settings: ReminderSettings): ReminderRuleSpec {
  if (template.kind === "relative") {
    return {
      triggerKind: "relative_timestamp",
      anchor: template.anchor,
      offsetSeconds: template.offsetMinutes * 60,
      purpose: template.purpose ?? "user_reminder",
      quietPolicy: "respect",
      origin: "default",
    };
  }
  return {
    triggerKind: "local_date",
    anchor: template.anchor,
    daysOffset: template.daysOffset,
    localTime: template.reference === "morning" ? settings.morningReferenceTime : settings.eveningReferenceTime,
    purpose: template.purpose ?? "user_reminder",
    quietPolicy: "respect",
    origin: "default",
  };
}

export function defaultRuleSpecs(task: TaskDefinition, templates: ReminderTemplate[], settings: ReminderSettings): ReminderRuleSpec[] {
  if (task.timeMode === "fuzzy") {
    return [{ triggerKind: "relative_timestamp", anchor: "review_at", offsetSeconds: 0, purpose: "planning_review", quietPolicy: "respect" }];
  }
  return templates.map((template) => ruleFromTemplate(template, settings));
}

function resolveAnchor(task: TaskDefinition, occurrence: OccurrenceProjection | null, anchor: ReminderRuleSpec["anchor"]): Date | undefined {
  if (anchor === "planned_start") return occurrence?.plannedStartAt ?? task.plannedStartAt;
  if (anchor === "planned_end") return occurrence?.plannedEndAt ?? task.plannedEndAt;
  if (anchor === "due_at") return occurrence?.dueAt ?? task.dueAt;
  if (anchor === "review_at") return task.reviewAt;
  return undefined;
}

function resolveLocalDate(task: TaskDefinition, occurrence: OccurrenceProjection | null, anchor: ReminderRuleSpec["anchor"], timezone: string): string | undefined {
  if (anchor === "due_at") {
    const local = occurrence?.dueLocalDate ?? task.dueLocalDate;
    if (local) return local;
    const exact = occurrence?.dueAt ?? task.dueAt;
    return exact ? localDateAt(exact, timezone) : undefined;
  }
  if (anchor === "planned_start") {
    const local = occurrence?.plannedLocalDate ?? task.plannedLocalDate;
    if (local) return local;
    const exact = occurrence?.plannedStartAt ?? task.plannedStartAt;
    return exact ? localDateAt(exact, timezone) : undefined;
  }
  return undefined;
}

export function resolveReminderIntent(rule: ReminderRuleSpec, task: TaskDefinition, occurrence: OccurrenceProjection | null, timezone: string): Date {
  if (rule.triggerKind === "exact") {
    if (!rule.exactAt) throw new Error("exact reminder requires exactAt");
    return rule.exactAt;
  }
  if (rule.triggerKind === "relative_timestamp") {
    const anchor = resolveAnchor(task, occurrence, rule.anchor);
    if (!anchor) throw new Error(`reminder anchor ${rule.anchor ?? "<missing>"} is unavailable`);
    return new Date(anchor.getTime() + (rule.offsetSeconds ?? 0) * 1_000);
  }
  const localDate = resolveLocalDate(task, occurrence, rule.anchor, timezone);
  if (!localDate || !rule.localTime) throw new Error("local-date reminder requires local date and localTime");
  return localDateAndTimeToUtc(shiftLocalDate(localDate, rule.daysOffset ?? 0), rule.localTime, timezone).date;
}

function eventBoundary(task: TaskDefinition, occurrence: OccurrenceProjection | null): Date | undefined {
  if (task.kind !== "event") return undefined;
  return occurrence?.plannedEndAt ?? occurrence?.plannedStartAt ?? task.plannedEndAt ?? task.plannedStartAt;
}

function staleForEvent(task: TaskDefinition, occurrence: OccurrenceProjection | null, at: Date): boolean {
  const boundary = eventBoundary(task, occurrence);
  return Boolean(boundary && at.getTime() > boundary.getTime());
}

function nextNonQuietMinute(at: Date, timezone: string, quiet: QuietHours): Date {
  if (!isQuietAt(at, timezone, quiet)) return at;
  let cursor = new Date(Math.ceil(at.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 36 * 60; i += 1) {
    if (!isQuietAt(cursor, timezone, quiet)) return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  throw new Error("quiet hours do not end within 36 hours");
}

export function applyNotificationPolicy(input: {
  intendedFor: Date;
  now: Date;
  task: TaskDefinition;
  occurrence: OccurrenceProjection | null;
  rule: ReminderRuleSpec;
  settings: ReminderSettings;
}): { scheduledFor: Date; suppressedReason?: SuppressedReason } {
  const latenessMs = input.now.getTime() - input.intendedFor.getTime();
  if (latenessMs > IMMEDIATE_DELIVERY_GRACE_MS) {
    return { scheduledFor: input.now, suppressedReason: "no_longer_applicable" };
  }
  if (latenessMs > 0) return { scheduledFor: input.now };
  let scheduledFor = input.intendedFor;

  if (input.settings.notificationsSnoozedUntil && scheduledFor < input.settings.notificationsSnoozedUntil) {
    scheduledFor = input.settings.notificationsSnoozedUntil;
    if (staleForEvent(input.task, input.occurrence, scheduledFor)) return { scheduledFor, suppressedReason: "snooze_stale" };
  }

  if (input.rule.quietPolicy === "respect" && isQuietAt(scheduledFor, input.settings.notificationTimezone, input.settings.quietHours)) {
    scheduledFor = nextNonQuietMinute(scheduledFor, input.settings.notificationTimezone, input.settings.quietHours);
    if (staleForEvent(input.task, input.occurrence, scheduledFor)) return { scheduledFor, suppressedReason: "quiet_stale" };
  }

  return { scheduledFor };
}

export function planReminders(input: {
  task: TaskDefinition;
  occurrence: OccurrenceProjection | null;
  rules: ReminderRuleSpec[];
  settings: ReminderSettings;
  now: Date;
  minimumMinutes?: number;
}): PlannedReminder[] {
  const candidates = input.rules.map((rule, ruleIndex) => {
    const intendedFor = resolveReminderIntent(rule, input.task, input.occurrence, input.occurrence?.timezone ?? input.task.timezone);
    const policy = applyNotificationPolicy({ intendedFor, now: input.now, task: input.task, occurrence: input.occurrence, rule, settings: input.settings });
    return { ruleIndex, intendedFor, ...policy };
  }).sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());

  const minimumMs = (input.minimumMinutes ?? 15) * 60_000;
  const merged: PlannedReminder[] = [];
  for (const candidate of candidates) {
    if (candidate.suppressedReason) {
      merged.push(candidate);
      continue;
    }
    const previous = merged.at(-1);
    if (previous && !previous.suppressedReason && candidate.scheduledFor.getTime() - previous.scheduledFor.getTime() < minimumMs) {
      const previousOrigin = input.rules[previous.ruleIndex]?.origin ?? "default";
      const candidateOrigin = input.rules[candidate.ruleIndex]?.origin ?? "default";
      if (previousOrigin === "explicit" && candidateOrigin !== "explicit") continue;
      if (candidateOrigin === "explicit" && previousOrigin !== "explicit") {
        merged[merged.length - 1] = candidate;
        continue;
      }
      // For equally ranked rules keep the later contact because it is closer to the actionable boundary.
      merged[merged.length - 1] = candidate;
    } else {
      merged.push(candidate);
    }
  }
  return merged;
}
