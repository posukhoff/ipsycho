export interface OccurrenceScheduleView {
  timezone: string;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  plannedLocalDate: string | null;
  dueAt: Date | null;
  dueLocalDate: string | null;
}

/** Human-readable time confirmed by persisted occurrence state. */
export function formatOccurrenceSchedule(schedule: OccurrenceScheduleView, locale = "ru-RU"): string | null {
  const exact = schedule.plannedStartAt ?? schedule.dueAt ?? schedule.plannedEndAt;
  if (exact) {
    const time = new Intl.DateTimeFormat(locale, {
      timeZone: schedule.timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(exact);
    return `📅 Запланировано: ${time} (${schedule.timezone})`;
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
