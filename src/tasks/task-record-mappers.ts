import type { ReminderRuleSpec, ReminderSettings } from "../core/reminder-planning.js";
import type { OccurrenceProjection } from "../core/recurrence.js";
import type { TaskDefinition } from "../core/types.js";
import { reminderRules, taskOccurrences, tasks, userSettings } from "../database/schema.js";

export function taskDefinitionFromRow(row: typeof tasks.$inferSelect, recurrenceExcludedLocalDates: readonly string[] = []): TaskDefinition {
  return {
    kind: row.kind,
    importance: row.importance,
    timeMode: row.timeMode,
    timezone: row.timezone,
    ...(row.plannedStartAt ? { plannedStartAt: row.plannedStartAt } : {}),
    ...(row.plannedEndAt ? { plannedEndAt: row.plannedEndAt } : {}),
    ...(row.plannedLocalDate ? { plannedLocalDate: row.plannedLocalDate } : {}),
    ...(row.dueAt ? { dueAt: row.dueAt } : {}),
    ...(row.dueLocalDate ? { dueLocalDate: row.dueLocalDate } : {}),
    ...(row.fuzzyHorizonText ? { fuzzyHorizonText: row.fuzzyHorizonText } : {}),
    ...(row.reviewAt ? { reviewAt: row.reviewAt } : {}),
    ...(row.recurrenceRule ? { recurrenceRule: row.recurrenceRule } : {}),
    ...(row.recurrenceTimezone ? { recurrenceTimezone: row.recurrenceTimezone } : {}),
    ...(row.recurrenceEndLocalDate ? { recurrenceEndLocalDate: row.recurrenceEndLocalDate } : {}),
    ...(recurrenceExcludedLocalDates.length ? { recurrenceExcludedLocalDates } : {}),
    ...(row.missPolicy ? { missPolicy: row.missPolicy } : {}),
    habitMode: row.habitMode,
    ...(row.minimumAction ? { minimumAction: row.minimumAction } : {}),
    ...(row.desiredAction ? { desiredAction: row.desiredAction } : {}),
    ...(row.habitTrigger ? { habitTrigger: row.habitTrigger } : {}),
  };
}

export function occurrenceProjectionFromRow(row: typeof taskOccurrences.$inferSelect): OccurrenceProjection {
  return {
    ...(row.recurrenceKey ? { recurrenceKey: row.recurrenceKey } : {}),
    status: row.status,
    timezone: row.timezone,
    ...(row.plannedStartAt ? { plannedStartAt: row.plannedStartAt } : {}),
    ...(row.plannedEndAt ? { plannedEndAt: row.plannedEndAt } : {}),
    ...(row.plannedLocalDate ? { plannedLocalDate: row.plannedLocalDate } : {}),
    ...(row.dueAt ? { dueAt: row.dueAt } : {}),
    ...(row.dueLocalDate ? { dueLocalDate: row.dueLocalDate } : {}),
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    ...(row.dstAdjusted ? { dstAdjusted: true } : {}),
  };
}

export function reminderSettingsFromRow(row: typeof userSettings.$inferSelect): ReminderSettings {
  return {
    notificationTimezone: row.quietHoursTimezone,
    quietHours: {
      enabled: row.quietHoursEnabled,
      weekday: { start: row.weekdayQuietStart, end: row.weekdayQuietEnd },
      weekend: { start: row.weekendQuietStart, end: row.weekendQuietEnd },
    },
    ...(row.notificationsSnoozedUntil ? { notificationsSnoozedUntil: row.notificationsSnoozedUntil } : {}),
    morningReferenceTime: row.morningReferenceTime,
    eveningReferenceTime: row.eveningReferenceTime,
  };
}

export function reminderRuleSpecFromRow(row: typeof reminderRules.$inferSelect): ReminderRuleSpec {
  const anchor = row.anchor as ReminderRuleSpec["anchor"];
  return {
    triggerKind: row.triggerKind,
    ...(row.exactAt ? { exactAt: row.exactAt } : {}),
    ...(anchor ? { anchor } : {}),
    ...(row.offsetSeconds !== null ? { offsetSeconds: row.offsetSeconds } : {}),
    ...(row.daysOffset !== null ? { daysOffset: row.daysOffset } : {}),
    ...(row.localTime ? { localTime: row.localTime } : {}),
    purpose: row.purpose,
    quietPolicy: row.quietPolicy,
    origin: row.origin as "default" | "explicit" | "system",
  };
}
