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
