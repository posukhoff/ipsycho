import type { FuzzySchedule, Importance, OccurrenceSchedule, OccurrenceStatus, RecurrenceView, TaskScope, Weekday } from "../../api/contracts.js";
import type { CopyKey, Translator } from "../../i18n/index.js";
import { dayOffset, formatInstantTime, formatLocalDate, instantToLocalDate } from "../../lib/index.js";

/**
 * Turning a persisted schedule into a sentence.
 *
 * The server sends the row exactly as it is stored — `OccurrenceScheduleView`, no rendered label —
 * because the client dictionary is its own (design.md § 7). So the wording lives here, once, and
 * every list row, group line and detail card reads the same four fields the same way.
 *
 * Nothing in this file asks the device what time it is. An instant is formatted **in the row's own
 * timezone**, and a local day is compared against the `todayLocalDate` the server sent.
 */

/** Which of the five shapes a stored occurrence is, decided from the fields rather than `timeMode`. */
export type ScheduleShape = "point" | "window" | "date" | "deadline" | "deadline_date" | "fuzzy" | "none";

export function scheduleShape(schedule: OccurrenceSchedule | null, fuzzy: FuzzySchedule | null): ScheduleShape {
  if (fuzzy) return "fuzzy";
  if (!schedule) return "none";
  if (schedule.plannedStartAt && schedule.plannedEndAt) return "window";
  if (schedule.plannedStartAt) return "point";
  if (schedule.dueAt) return "deadline";
  if (schedule.dueLocalDate) return "deadline_date";
  if (schedule.plannedLocalDate) return "date";
  return "none";
}

/** The time half: «в 10:00», «13:00–15:00», «до 18:00», «весь день». Never the day. */
export function scheduleTimeText(schedule: OccurrenceSchedule | null, fuzzy: FuzzySchedule | null, t: Translator): string {
  const shape = scheduleShape(schedule, fuzzy);
  const zone = schedule?.timezone ?? fuzzy?.timezone ?? "UTC";
  switch (shape) {
    case "window":
      return t("schedule.window", {
        start: formatInstantTime(schedule!.plannedStartAt!, zone, t.locale),
        end: formatInstantTime(schedule!.plannedEndAt!, zone, t.locale),
      });
    case "point":
      return t("schedule.at", { time: formatInstantTime(schedule!.plannedStartAt!, zone, t.locale) });
    case "deadline":
      return t("schedule.deadline", { time: formatInstantTime(schedule!.dueAt!, zone, t.locale) });
    case "deadline_date":
      return t("schedule.deadline_date", { date: formatLocalDate(schedule!.dueLocalDate!, t.locale) });
    case "date":
      return t("schedule.date_only");
    case "fuzzy":
      return fuzzy?.horizonText ? t("schedule.fuzzy", { horizon: fuzzy.horizonText }) : t("schedule.none");
    case "none":
      return t("schedule.none");
  }
}

/** «сегодня», «завтра», «вчера», else `5 сент.`. Both days are already local; nothing is derived. */
export function dayText(localDate: string | null, todayLocalDate: string, t: Translator): string {
  if (!localDate) return "";
  switch (dayOffset(localDate, todayLocalDate)) {
    case "today":
      return t("common.today");
    case "tomorrow":
      return t("common.tomorrow");
    case "yesterday":
      return t("common.yesterday");
    case "other":
      return formatLocalDate(localDate, t.locale, { todayLocalDate });
  }
}

/** The whole line a row shows under its title: the day and the time, or the fuzzy horizon. */
export function scheduleLine(row: { schedule: OccurrenceSchedule | null; fuzzy: FuzzySchedule | null; localDate: string | null }, todayLocalDate: string, t: Translator): string {
  const time = scheduleTimeText(row.schedule, row.fuzzy, t);
  if (row.fuzzy) {
    const review = row.fuzzy.reviewAt ? t("schedule.fuzzy_review", { date: dayText(instantToLocalDate(row.fuzzy.reviewAt, row.fuzzy.timezone), todayLocalDate, t) }) : "";
    return [time, review].filter(Boolean).join(" · ");
  }
  const day = dayText(row.localDate, todayLocalDate, t);
  return [day, time].filter(Boolean).join(", ");
}

const WEEKDAY_KEYS: Record<Weekday, CopyKey> = {
  MO: "weekday.1",
  TU: "weekday.2",
  WE: "weekday.3",
  TH: "weekday.4",
  FR: "weekday.5",
  SA: "weekday.6",
  SU: "weekday.7",
};

const FREQUENCY_KEYS: Record<RecurrenceView["frequency"], CopyKey> = {
  daily: "recurrence.daily",
  weekly: "recurrence.weekly",
  monthly: "recurrence.monthly",
};

const INTERVAL_KEYS: Record<RecurrenceView["frequency"], CopyKey> = {
  daily: "recurrence.every_days",
  weekly: "recurrence.every_weeks",
  monthly: "recurrence.every_months",
};

/** «Каждую неделю · Пн, Ср, Пт · До 18 дек. · пропущено дат: 2» — the rule, already parsed. */
export function recurrenceLine(recurrence: RecurrenceView | null, t: Translator, options: { todayLocalDate?: string } = {}): string {
  if (!recurrence) return "";
  const parts: string[] = [recurrence.interval === 1 ? t(FREQUENCY_KEYS[recurrence.frequency]) : t(INTERVAL_KEYS[recurrence.frequency], { n: recurrence.interval })];
  if (recurrence.weekdays.length > 0) parts.push(recurrence.weekdays.map((day) => t(WEEKDAY_KEYS[day])).join(", "));
  if (recurrence.monthDays.length > 0) parts.push(recurrence.monthDays.join(", "));
  if (recurrence.localTimes.length > 0) parts.push(recurrence.localTimes.join(", "));
  parts.push(recurrence.endLocalDate ? t("recurrence.until", { date: formatLocalDate(recurrence.endLocalDate, t.locale, options) }) : t("recurrence.endless"));
  if (recurrence.excludedLocalDates.length > 0) parts.push(t("recurrence.skip_dates_count", { count: recurrence.excludedLocalDates.length }));
  return parts.join(" · ");
}

const IMPORTANCE_KEYS: Record<Importance, CopyKey> = {
  normal: "task.importance_normal",
  required: "task.importance_required",
  critical: "task.importance_critical",
};

export function importanceText(importance: Importance, t: Translator): string {
  return t(IMPORTANCE_KEYS[importance]);
}

const STATUS_KEYS: Record<OccurrenceStatus, CopyKey> = {
  scheduled: "state.scheduled",
  open: "state.open",
  in_progress: "state.started",
  done: "state.done",
  skipped: "state.skipped",
  cancelled: "state.cancelled",
  elapsed: "state.elapsed",
};

export function occurrenceStatusText(status: OccurrenceStatus, t: Translator): string {
  return t(STATUS_KEYS[status]);
}

export const TASK_SCOPE_KEYS: Record<TaskScope, CopyKey> = {
  overdue: "tasks.scope_overdue",
  today: "tasks.scope_today",
  week: "tasks.scope_week",
  month: "tasks.scope_month",
  all: "tasks.scope_all",
  nodate: "tasks.scope_nodate",
};

/**
 * `task_events.event_type` is a token, not a sentence: the dictionary renders it. An unknown token
 * — a new event type the server grows before the client does — falls back rather than showing raw.
 */
export function journalText(eventType: string, t: Translator): string {
  const token = eventType.toLowerCase();
  if (token.includes("resched")) return t("journal.rescheduled");
  if (token.includes("done") || token.includes("complete")) return t("journal.done");
  if (token.includes("progress") || token.includes("start")) return t("journal.started");
  if (token.includes("skip")) return t("journal.skipped");
  if (token.includes("cancel")) return t("journal.cancelled");
  if (token.includes("resum")) return t("journal.resumed");
  if (token.includes("paus")) return t("journal.paused");
  if (token.includes("remind")) return t("journal.reminder");
  if (token.includes("creat")) return t("journal.created");
  if (token.includes("updat") || token.includes("chang")) return t("journal.updated");
  return t("journal.other");
}
