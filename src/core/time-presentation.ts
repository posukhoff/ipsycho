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
    return `📅 Событие: ${time} (${schedule.timezone})`;
  }
  const date = schedule.plannedLocalDate ?? schedule.dueLocalDate;
  return date ? `📅 Событие: ${date} (${schedule.timezone})` : null;
}
