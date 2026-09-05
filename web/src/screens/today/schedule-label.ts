import type { TaskListRow } from "../../api/contracts.js";
import type { Translator } from "../../i18n/index.js";
import { dayOffset, formatInstantTime, formatLocalDate } from "../../lib/index.js";

/**
 * Wording one occurrence's time, from the persisted fields and nothing else.
 *
 * The contract's rule (`src/api/contracts/primitives.ts`) is that an instant crosses the wire as
 * UTC and is rendered **in the row's own timezone**, and that a local day arrives as `YYYY-MM-DD`
 * already in that zone. So nothing here asks the device what time or what day it is: `new Date()`
 * appears exactly once, inside `formatInstantTime`, and only as the argument to a formatter that
 * was built with `timeZone: schedule.timezone`.
 *
 * The five shapes are the ones `OccurrenceScheduleSchema` can carry, in the order the domain
 * decides them (`src/core/time-presentation.ts`): a deadline wins over a planned time, a planned
 * start with an end is a window, a planned start alone is a point, and a day with no clock time is
 * "весь день". A fuzzy task has no occurrence at all, so it words its horizon instead.
 */
export function whenLabel(row: TaskListRow, t: Translator, options: { todayLocalDate?: string; withDate?: boolean } = {}): string {
  const locale = t.locale;
  const schedule = row.schedule;

  if (!schedule) {
    const horizon = row.fuzzy?.horizonText;
    return horizon ? t("schedule.fuzzy", { horizon }) : t("schedule.none");
  }

  const zone = schedule.timezone;
  const prefix = options.withDate && row.localDate ? `${dateLabel(row.localDate, t, options.todayLocalDate)} ` : "";

  if (schedule.dueAt) return `${prefix}${t("schedule.deadline", { time: formatInstantTime(schedule.dueAt, zone, locale) })}`;
  if (schedule.dueLocalDate) return t("schedule.deadline_date", { date: dateLabel(schedule.dueLocalDate, t, options.todayLocalDate) });
  if (schedule.plannedStartAt) {
    const start = formatInstantTime(schedule.plannedStartAt, zone, locale);
    if (schedule.plannedEndAt) return `${prefix}${t("schedule.window", { start, end: formatInstantTime(schedule.plannedEndAt, zone, locale) })}`;
    return `${prefix}${t("schedule.at", { time: start })}`;
  }
  if (schedule.plannedLocalDate) return `${prefix}${t("schedule.date_only")}`;
  return prefix.trim() || t("schedule.none");
}

/**
 * «сегодня» / «завтра» / «вчера» where the word exists, and a formatted day everywhere else.
 *
 * `dayOffset` compares two `YYYY-MM-DD` strings and nothing else — `todayLocalDate` is the server's
 * answer for the user's zone, carried on every list response, never the device's idea of today.
 */
export function dateLabel(localDate: string, t: Translator, todayLocalDate?: string): string {
  if (todayLocalDate === undefined) return formatLocalDate(localDate, t.locale);
  switch (dayOffset(localDate, todayLocalDate)) {
    case "today":
      return t("common.today");
    case "tomorrow":
      return t("common.tomorrow");
    case "yesterday":
      return t("common.yesterday");
    default:
      return formatLocalDate(localDate, t.locale, { todayLocalDate });
  }
}
