import type { ReminderSchedulingService } from "../../reminders/reminder-scheduling.service.js";
import { localDateAt } from "../../core/timezone.js";
import type { ReminderRow } from "../contracts/index.js";

/**
 * One pending delivery, as the reminders screen reads it.
 *
 * The row type is derived from the service rather than restated, so a column added to
 * `reminder_deliveries` shows up here as a type error rather than as a silently missing field.
 */
export type UpcomingReminder = Awaited<ReturnType<ReminderSchedulingService["listUpcoming"]>>[number];

/**
 * `localDate` is computed here, with the occurrence's own timezone, because the client groups the
 * list by day and must not decide what day a moment belongs to: the domain stores a local day and a
 * zone side by side, and re-deriving one in a browser set to UTC-5 moves a Kyiv evening into
 * yesterday. The task's zone is the fallback for a delivery that hangs on a dateless task.
 */
export function presentReminder(row: UpcomingReminder): ReminderRow {
  const timezone = row.occurrence?.timezone ?? row.task.timezone;
  return {
    deliveryId: row.delivery.id,
    taskId: row.delivery.taskId,
    occurrenceId: row.delivery.occurrenceId,
    title: row.task.title,
    scheduledFor: row.delivery.scheduledFor.toISOString(),
    // What the reminder is *about*, before quiet hours or a notification snooze moved the delivery.
    // The screen shows the pair when they differ, which is the only way «why is this at 08:00»
    // has an answer on the surface that caused it.
    intendedFor: row.delivery.intendedFor.toISOString(),
    timezone,
    localDate: localDateAt(row.delivery.scheduledFor, timezone),
    purpose: row.rule.purpose,
    // A system `follow_up` rule is created by exactly one thing: `scheduleFollowUpChoice`, behind
    // «отложить». An explicit reminder the user asked for is `user_reminder`, however late it is.
    followUp: row.rule.purpose === "follow_up" && row.rule.origin === "system",
  };
}
