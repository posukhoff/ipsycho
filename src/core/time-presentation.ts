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
    timeZone: timezone, day: "2-digit", month: "2-digit", ...(showYear ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit",
  }).format(at);
}

function localYear(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(at);
}

/** Clock time only ("18:05") in the user's timezone. */
export function formatLocalTime(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(at);
}

/** "05.09" for a local date in the current year, "05.09.2027" otherwise. */
export function formatLocalDateLabel(localDate: string, timezone: string, now: Date): string {
  const [year, month, day] = localDate.split("-");
  if (!year || !month || !day) return localDate;
  return localDateAt(now, timezone).slice(0, 4) === year ? `${day}.${month}` : `${day}.${month}.${year}`;
}

/** Persisted schedule as the user reads it in a report: "05.09, 10:00–11:00", "до 12.09, 18:00", "05.09". */
export function scheduleLabel(schedule: OccurrenceScheduleView, now: Date): string {
  if (schedule.plannedStartAt && schedule.plannedEndAt) {
    const end = localDateAt(schedule.plannedStartAt, schedule.timezone) === localDateAt(schedule.plannedEndAt, schedule.timezone)
      ? formatLocalTime(schedule.plannedEndAt, schedule.timezone)
      : formatLocalDateTime(schedule.plannedEndAt, schedule.timezone, now);
    return `${formatLocalDateTime(schedule.plannedStartAt, schedule.timezone, now)}–${end}`;
  }
  if (schedule.plannedStartAt) return formatLocalDateTime(schedule.plannedStartAt, schedule.timezone, now);
  if (schedule.dueAt) return `до ${formatLocalDateTime(schedule.dueAt, schedule.timezone, now)}`;
  if (schedule.plannedLocalDate) return formatLocalDateLabel(schedule.plannedLocalDate, schedule.timezone, now);
  if (schedule.dueLocalDate) return `до ${formatLocalDateLabel(schedule.dueLocalDate, schedule.timezone, now)}`;
  return "без времени";
}

/** Human-readable time confirmed by persisted occurrence state. */
export function formatOccurrenceSchedule(schedule: OccurrenceScheduleView, locale = "ru-RU", now?: Date): string | null {
  const exact = schedule.plannedStartAt ?? schedule.dueAt ?? schedule.plannedEndAt;
  if (exact) {
    return `📅 Запланировано: ${formatLocalDateTime(exact, schedule.timezone, now, locale)} (${schedule.timezone})`;
  }
  const date = schedule.plannedLocalDate ?? schedule.dueLocalDate;
  return date ? `📅 Запланировано: ${date} (${schedule.timezone})` : null;
}

/** Do not repeat a reminder when Telegram would render it as the same minute as the displayed schedule anchor. */
export function reminderAddsTimingInformation(schedule: OccurrenceScheduleView, reminderAt: Date): boolean {
  const displayedExact = schedule.plannedStartAt ?? schedule.dueAt ?? schedule.plannedEndAt;
  if (!displayedExact) return true;
  return Math.floor(displayedExact.getTime() / 60_000) !== Math.floor(reminderAt.getTime() / 60_000);
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

const WEEKDAY_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"] as const;

/** "сегодня", "завтра", "вчера" or "сб 05.09" (with the year when it is not the current one). */
export function relativeDayLabel(localDate: string, timezone: string, now: Date): string {
  const today = localDateAt(now, timezone);
  if (localDate === today) return "сегодня";
  if (localDate === shiftLocalDate(today, 1)) return "завтра";
  if (localDate === shiftLocalDate(today, -1)) return "вчера";
  const [year, month, day] = localDate.split("-").map(Number);
  if (!year || !month || !day) return localDate;
  const weekday = WEEKDAY_SHORT[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
  return `${weekday} ${formatLocalDateLabel(localDate, timezone, now)}`;
}

/**
 * Pre-formatted local time for the model context. Never an ISO instant: the model reads
 * "сегодня 18:00" or "до сб 12.09, 18:00" and answers in the user's own frame of reference.
 */
export function formatWhenForModel(when: ModelWhenView, timezone: string, now: Date): string {
  const day = (at: Date) => relativeDayLabel(localDateAt(at, timezone), timezone, now);
  if (when.plannedStartAt) {
    const start = `${day(when.plannedStartAt)} ${formatLocalTime(when.plannedStartAt, timezone)}`;
    if (!when.plannedEndAt) return start;
    const sameDay = localDateAt(when.plannedStartAt, timezone) === localDateAt(when.plannedEndAt, timezone);
    return sameDay
      ? `${start}–${formatLocalTime(when.plannedEndAt, timezone)}`
      : `${start} – ${day(when.plannedEndAt)} ${formatLocalTime(when.plannedEndAt, timezone)}`;
  }
  if (when.dueAt) return `до ${day(when.dueAt)}, ${formatLocalTime(when.dueAt, timezone)}`;
  if (when.plannedLocalDate) return relativeDayLabel(when.plannedLocalDate, timezone, now);
  if (when.dueLocalDate) return `до ${relativeDayLabel(when.dueLocalDate, timezone, now)}`;
  if (when.fuzzyHorizonText) {
    const review = when.reviewAt ? `, пересмотр ${day(when.reviewAt)}` : "";
    return `~ «${when.fuzzyHorizonText.trim()}»${review}`;
  }
  return "без времени";
}

/** Local wall-clock parts the current-time line is built from; exported for tests and for the prompt. */
export function localWeekdayName(at: Date, timezone: string): string {
  const { year, month, day } = localDateTimeAt(at, timezone);
  return ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"][new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
}
