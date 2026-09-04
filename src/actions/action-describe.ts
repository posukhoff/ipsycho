import type { Reminder, ResolvedAction, ResolvedActionOf, When } from "../core/ai-contract.js";
import { normalizeLanguageTag } from "../core/language.js";

/** Pending-confirmation wording: what will happen if the user taps Confirm. */
export function describeAction(action: ResolvedAction): string {
  switch (action.type) {
    case "create_task":
      return `Создать «${action.body.title.trim()}»${describeWhen(action.body.when)}`;
    case "plan":
      return `Создать цель «${action.goal.title}» и ${action.tasks.length} ${plural(action.tasks.length, "задачу", "задачи", "задач")}`;
    case "update_task": {
      const patch = action.patch;
      const parts: string[] = [];
      if (patch.title !== null) parts.push(`название → «${patch.title}»`);
      if (patch.importance !== null) parts.push(`важность → ${patch.importance === "critical" ? "критическая" : patch.importance === "required" ? "обязательная" : "обычная"}`);
      if (patch.habit !== null) parts.push("minimumAction" in patch.habit ? "включить режим привычки" : "выключить режим привычки");
      if (patch.checklist !== null) parts.push(`чеклист (${patch.checklist.length})`);
      if (patch.why !== null) parts.push("зачем");
      if (patch.nextAction !== null) parts.push("следующий шаг");
      if (patch.context !== null) parts.push("контекст");
      return parts.length ? `Изменить задачу: ${parts.join(", ")}` : "Изменить задачу";
    }
    case "set_task_state": {
      const series = action.target.kind === "series" ? " (всю серию)" : "";
      if (action.state === "done") return "Отметить выполненной";
      if (action.state === "started") return "Начать";
      if (action.state === "skipped") return "Пропустить";
      if (action.state === "cancelled") return `Отменить${series}`;
      return action.note ? `Записать блокер: «${action.note.trim().slice(0, 120)}»` : "Отметить увиденной";
    }
    case "reschedule":
      return `${action.target.kind === "series" ? "Изменить расписание серии" : "Перенести"}${describeWhen(action.when)}${action.reason ? ` (${action.reason})` : ""}`;
    case "set_reminder":
      if (action.mode === "clear") return "Убрать напоминания";
      return `${action.mode === "add" ? "Добавить напоминание" : "Заменить напоминание"}${action.reminder ? describeReminder(action.reminder) : ""}`;
    case "goal":
      if (action.op === "create") return `Создать цель «${action.title ?? ""}»`;
      if (action.op === "link") return "Связать задачу с целью";
      if (action.op === "unlink") return "Отвязать задачу от цели";
      return action.status ? `Цель → ${action.status === "completed" ? "завершена" : action.status === "paused" ? "на паузе" : action.status === "cancelled" ? "отменена" : "активна"}` : "Изменить цель";
    case "memory":
      if (action.op === "delete") return "Удалить запись из памяти";
      if (action.op === "update") return action.content ? `Изменить запись в памяти: «${action.content.trim().slice(0, 120)}»` : "Изменить запись в памяти";
      return `Запомнить${action.sensitive ? " (чувствительное)" : ""}: «${(action.content ?? "").trim().slice(0, 120)}»`;
    case "settings":
      return `Изменить настройки: ${settingsOperationLabel(action)}`;
  }
}

export function describeWhen(when: When): string {
  const date = (value: string) => value.split("-").slice(1).reverse().join(".");
  switch (when.mode) {
    case "fuzzy": return ` — ${when.horizonText}`;
    case "deadline": return ` — до ${date(when.date)}${when.time ? ` ${when.time}` : ""}`;
    case "date": return ` — ${date(when.date)}`;
    case "exact": return ` — ${date(when.date)} ${when.time}${when.durationMinutes ? ` (${when.durationMinutes} мин)` : ""}`;
  }
}

function describeReminder(reminder: Reminder): string {
  const bypass = reminder.quiet === "bypass" ? " — игнорируя тихие часы" : "";
  if (reminder.kind === "at") return ` ${reminder.date.split("-").slice(1).reverse().join(".")} ${reminder.time}${bypass}`;
  if (reminder.kind === "offset") {
    const anchor = reminder.anchor === "due" ? "срока" : reminder.anchor === "end" ? "конца" : "начала";
    const offset = reminder.minutes < 0 ? `за ${Math.abs(reminder.minutes)} мин до` : reminder.minutes > 0 ? `через ${reminder.minutes} мин после` : "в момент";
    return ` ${offset} ${anchor}${bypass}`;
  }
  return ` в ${reminder.time}${reminder.daysOffset ? ` (${reminder.daysOffset > 0 ? "+" : ""}${reminder.daysOffset} дн)` : ""}${bypass}`;
}

function settingsOperationLabel(action: ResolvedActionOf<"settings">): string {
  switch (action.operation) {
    case "timezone": return `часовой пояс → ${action.timezone ?? ""}`;
    case "language": return "язык";
    case "digest": return "дайджест";
    case "weekly_review": return "недельный обзор";
    case "quiet_hours": return "тихие часы";
    case "snooze": return "пауза уведомлений";
    case "reminder_defaults": return "напоминания по умолчанию";
  }
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** The user_settings patch and card title for a resolved settings action. */
export function settingsPatchForAction(
  action: ResolvedActionOf<"settings">,
  current: { timezone: string },
  snoozeUntil: Date | null,
): { patch: Record<string, unknown>; title: string } {
  if (action.operation === "timezone") {
    return { patch: { timezone: action.timezone!, ...(action.applyTimezoneTo === "all" ? { digestTimezone: action.timezone!, quietHoursTimezone: action.timezone! } : {}) }, title: "Изменить часовой пояс" };
  }
  if (action.operation === "language") {
    return { patch: { pinnedLanguage: action.language === null ? null : normalizeLanguageTag(action.language) }, title: "Изменить язык интерфейса" };
  }
  if (action.operation === "digest") {
    const patch = action.digestKind === "morning"
      ? { morningDigestEnabled: action.enabled!, digestTimezone: current.timezone, ...(action.time !== null ? { morningReferenceTime: action.time } : {}) }
      : { eveningDigestEnabled: action.enabled!, digestTimezone: current.timezone, ...(action.time !== null ? { eveningReferenceTime: action.time } : {}) };
    return { patch, title: action.digestKind === "morning" ? "Настроить утреннюю сводку" : "Настроить вечернюю сводку" };
  }
  if (action.operation === "weekly_review") {
    return { patch: { weeklyReviewEnabled: action.enabled!, digestTimezone: current.timezone, ...(action.weekday !== null ? { weeklyReviewWeekday: action.weekday } : {}), ...(action.time !== null ? { weeklyReviewTime: action.time } : {}) }, title: "Настроить еженедельный обзор" };
  }
  if (action.operation === "quiet_hours") {
    return { patch: { quietHoursEnabled: action.enabled!, quietHoursTimezone: current.timezone, ...(action.weekdayStart !== null ? { weekdayQuietStart: action.weekdayStart } : {}), ...(action.weekdayEnd !== null ? { weekdayQuietEnd: action.weekdayEnd } : {}), ...(action.weekendStart !== null ? { weekendQuietStart: action.weekendStart } : {}), ...(action.weekendEnd !== null ? { weekendQuietEnd: action.weekendEnd } : {}) }, title: "Настроить тихие часы" };
  }
  if (action.operation === "snooze") {
    return { patch: { notificationsSnoozedUntil: snoozeUntil }, title: snoozeUntil === null ? "Включить уведомления" : "Приостановить уведомления" };
  }
  return { patch: {
    ...(action.eventOffsets !== null ? { eventReminderOffsetsMinutes: [...new Set(action.eventOffsets)].sort((a, b) => a - b) } : {}),
    ...(action.plannedTaskOffsetMinutes !== null ? { plannedTaskReminderOffsetMinutes: action.plannedTaskOffsetMinutes } : {}),
    ...(action.criticalPostDueMinutes !== null ? { criticalPostDueMinutes: action.criticalPostDueMinutes } : {}),
    ...(action.seenNormalMinutes !== null ? { seenNormalMinutes: action.seenNormalMinutes } : {}),
    ...(action.seenRequiredMinutes !== null ? { seenRequiredMinutes: action.seenRequiredMinutes } : {}),
    ...(action.seenCriticalMinutes !== null ? { seenCriticalMinutes: action.seenCriticalMinutes } : {}),
  }, title: "Изменить стандартные напоминания" };
}
