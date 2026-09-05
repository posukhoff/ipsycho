import { localDateAt, localDateTimeAt, shiftLocalDate } from "./timezone.js";

export interface OccurrenceScheduleView {
  timezone: string;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  plannedLocalDate: string | null;
  dueAt: Date | null;
  dueLocalDate: string | null;
}

/**
 * Day, month and clock time in the user's timezone. The year is added only when it differs
 * from the current one: "23.08, 10:00" for a reminder a year away silently reads as "today".
 */
export function formatLocalDateTime(at: Date, timezone: string, now?: Date, locale = "ru-RU"): string {
  const showYear = now !== undefined && localYear(at, timezone) !== localYear(now, timezone);
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    ...(showYear ? { year: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}

function localYear(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(at);
}

export type PresentationLocale = "ru" | "uk" | "en";

/** Intl tag for one of the interface locales; dates and clock times follow it ("23.08, 18:00" vs "08/23, 06:00 PM"). */
export function intlLocale(locale: PresentationLocale): string {
  return locale === "uk" ? "uk-UA" : locale === "en" ? "en-GB" : "ru-RU";
}

const WORDS: Record<PresentationLocale, { by: string; noTime: string; today: string; tomorrow: string; yesterday: string; review: string; weekdays: readonly string[] }> = {
  ru: { by: "до", noTime: "без времени", today: "сегодня", tomorrow: "завтра", yesterday: "вчера", review: "пересмотр", weekdays: ["вс", "пн", "вт", "ср", "чт", "пт", "сб"] },
  uk: { by: "до", noTime: "без часу", today: "сьогодні", tomorrow: "завтра", yesterday: "вчора", review: "перегляд", weekdays: ["нд", "пн", "вт", "ср", "чт", "пт", "сб"] },
  en: { by: "by", noTime: "no time", today: "today", tomorrow: "tomorrow", yesterday: "yesterday", review: "review", weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] },
};

/** Clock time only ("18:05") in the user's timezone. */
export function formatLocalTime(at: Date, timezone: string, locale = "ru-RU"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(at);
}

/** "05.09" for a local date in the current year, "05.09.2027" otherwise. */
export function formatLocalDateLabel(localDate: string, timezone: string, now: Date): string {
  const [year, month, day] = localDate.split("-");
  if (!year || !month || !day) return localDate;
  return localDateAt(now, timezone).slice(0, 4) === year ? `${day}.${month}` : `${day}.${month}.${year}`;
}

/** Persisted schedule as the user reads it in a report: "05.09, 10:00–11:00", "до 12.09, 18:00", "05.09". */
export function scheduleLabel(schedule: OccurrenceScheduleView, now: Date, locale: PresentationLocale = "ru"): string {
  const tag = intlLocale(locale);
  const words = WORDS[locale];
  if (schedule.plannedStartAt && schedule.plannedEndAt) {
    const end =
      localDateAt(schedule.plannedStartAt, schedule.timezone) === localDateAt(schedule.plannedEndAt, schedule.timezone)
        ? formatLocalTime(schedule.plannedEndAt, schedule.timezone, tag)
        : formatLocalDateTime(schedule.plannedEndAt, schedule.timezone, now, tag);
    return `${formatLocalDateTime(schedule.plannedStartAt, schedule.timezone, now, tag)}–${end}`;
  }
  if (schedule.plannedStartAt) return formatLocalDateTime(schedule.plannedStartAt, schedule.timezone, now, tag);
  if (schedule.dueAt) return `${words.by} ${formatLocalDateTime(schedule.dueAt, schedule.timezone, now, tag)}`;
  if (schedule.plannedLocalDate) return formatLocalDateLabel(schedule.plannedLocalDate, schedule.timezone, now);
  if (schedule.dueLocalDate) return `${words.by} ${formatLocalDateLabel(schedule.dueLocalDate, schedule.timezone, now)}`;
  return words.noTime;
}

/** What the model needs to know about a task's time: an occurrence schedule, or a fuzzy horizon with its review date. */
export interface ModelWhenView {
  plannedStartAt?: Date | null;
  plannedEndAt?: Date | null;
  plannedLocalDate?: string | null;
  dueAt?: Date | null;
  dueLocalDate?: string | null;
  fuzzyHorizonText?: string | null;
  reviewAt?: Date | null;
}

/** "сегодня", "завтра", "вчера" or "сб 05.09" (with the year when it is not the current one). */
export function relativeDayLabel(localDate: string, timezone: string, now: Date, locale: PresentationLocale = "ru"): string {
  const words = WORDS[locale];
  const today = localDateAt(now, timezone);
  if (localDate === today) return words.today;
  if (localDate === shiftLocalDate(today, 1)) return words.tomorrow;
  if (localDate === shiftLocalDate(today, -1)) return words.yesterday;
  const [year, month, day] = localDate.split("-").map(Number);
  if (!year || !month || !day) return localDate;
  const weekday = words.weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
  return `${weekday} ${formatLocalDateLabel(localDate, timezone, now)}`;
}

/**
 * Pre-formatted local time for the model context. Never an ISO instant: the model reads
 * "сегодня 18:00" or "до сб 12.09, 18:00" and answers in the user's own frame of reference.
 */
export function formatWhenForModel(when: ModelWhenView, timezone: string, now: Date, locale: PresentationLocale = "ru"): string {
  const words = WORDS[locale];
  const day = (at: Date) => relativeDayLabel(localDateAt(at, timezone), timezone, now, locale);
  if (when.plannedStartAt) {
    const start = `${day(when.plannedStartAt)} ${formatLocalTime(when.plannedStartAt, timezone)}`;
    if (!when.plannedEndAt) return start;
    const sameDay = localDateAt(when.plannedStartAt, timezone) === localDateAt(when.plannedEndAt, timezone);
    return sameDay ? `${start}–${formatLocalTime(when.plannedEndAt, timezone)}` : `${start} – ${day(when.plannedEndAt)} ${formatLocalTime(when.plannedEndAt, timezone)}`;
  }
  if (when.dueAt) return `${words.by} ${day(when.dueAt)}, ${formatLocalTime(when.dueAt, timezone)}`;
  if (when.plannedLocalDate) return relativeDayLabel(when.plannedLocalDate, timezone, now, locale);
  if (when.dueLocalDate) return `${words.by} ${relativeDayLabel(when.dueLocalDate, timezone, now, locale)}`;
  if (when.fuzzyHorizonText) {
    const review = when.reviewAt ? `, ${words.review} ${day(when.reviewAt)}` : "";
    return `~ «${when.fuzzyHorizonText.trim()}»${review}`;
  }
  return words.noTime;
}

/** Local wall-clock parts the current-time line is built from; exported for tests and for the prompt. */
export function localWeekdayName(at: Date, timezone: string): string {
  const { year, month, day } = localDateTimeAt(at, timezone);
  return ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"][new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
}
