import { formatLocalDateTime, formatLocalTime, intlLocale, scheduleLabel, type OccurrenceScheduleView } from "./time-presentation.js";
import { localDateAt } from "./timezone.js";
import type { Importance } from "./types.js";

/**
 * What the application actually persisted for one user turn. The AI reply is free prose and
 * may promise something the actions did not do; this report is rendered from stored results
 * only, so the user can verify every change without opening the task.
 */
export type AppliedReportItem =
  | {
      kind: "task_created";
      title: string;
      timezone: string;
      importance?: Importance;
      recurring?: boolean;
      schedule: OccurrenceScheduleView | null;
      fuzzyHorizonText?: string | null;
      reviewAt?: Date | null;
      reminderAt: Date | null;
      goalTitle?: string | null;
    }
  | { kind: "task_updated"; title: string; changes: TaskFieldChange[] }
  | {
      kind: "task_rescheduled";
      title: string;
      before: OccurrenceScheduleView | null;
      after: OccurrenceScheduleView | null;
      reminderAt: Date | null;
      reason?: string | null;
      fromFuzzy?: string | null;
    }
  | { kind: "occurrence"; title: string; operation: "done" | "start" | "skip" | "cancel" | "seen" | "record_blocker"; details?: string | null }
  | { kind: "reminder"; title: string; mode: "add" | "replace" | "clear"; schedule: OccurrenceScheduleView | null; reminderAt: Date | null }
  | { kind: "series"; title: string; operation: "pause" | "resume" | "stop" | "cancel" | "edit" }
  | { kind: "goal_created"; title: string }
  | { kind: "goal_updated"; title: string }
  | { kind: "goal_plan"; goalTitle: string; tasks: Array<Extract<AppliedReportItem, { kind: "task_created" }>> }
  | { kind: "goal_linked"; taskTitle: string; goalTitle: string }
  | { kind: "goal_unlinked"; taskTitle: string; goalTitle: string }
  | { kind: "memory"; operation: "saved" | "updated" | "deleted"; content: string }
  | { kind: "settings"; operation: "timezone" | "language" | "digest" | "weekly_review" | "quiet_hours" | "snooze" | "reminder_defaults" }
  | { kind: "generic"; title: string };

export interface TaskFieldChange {
  field: "title" | "why" | "nextAction" | "context" | "importance" | "checklist" | "habitMode" | "minimumAction" | "desiredAction" | "habitTrigger";
  before: string | null;
  after: string | null;
}

export type ReportLocale = "ru" | "uk" | "en";

const FIELD_LABELS: Record<ReportLocale, Record<TaskFieldChange["field"], string>> = {
  ru: {
    title: "Название",
    why: "Зачем",
    nextAction: "Следующий шаг",
    context: "Контекст",
    importance: "Важность",
    checklist: "Чеклист",
    habitMode: "Режим привычки",
    minimumAction: "Минимальное действие",
    desiredAction: "Желаемое действие",
    habitTrigger: "Триггер привычки",
  },
  uk: {
    title: "Назва",
    why: "Навіщо",
    nextAction: "Наступний крок",
    context: "Контекст",
    importance: "Важливість",
    checklist: "Чекліст",
    habitMode: "Режим звички",
    minimumAction: "Мінімальна дія",
    desiredAction: "Бажана дія",
    habitTrigger: "Тригер звички",
  },
  en: {
    title: "Title",
    why: "Why",
    nextAction: "Next step",
    context: "Context",
    importance: "Importance",
    checklist: "Checklist",
    habitMode: "Habit mode",
    minimumAction: "Minimum action",
    desiredAction: "Desired action",
    habitTrigger: "Habit trigger",
  },
};

const IMPORTANCE_LABELS: Record<ReportLocale, Record<Importance, string>> = {
  ru: { normal: "обычная", required: "обязательная", critical: "критическая" },
  uk: { normal: "звичайна", required: "обов'язкова", critical: "критична" },
  en: { normal: "normal", required: "required", critical: "critical" },
};

const OCCURRENCE_LABELS: Record<ReportLocale, Record<Extract<AppliedReportItem, { kind: "occurrence" }>["operation"], string>> = {
  ru: { done: "✅ Выполнено", start: "▶️ Начато", skip: "⏭ Пропущено", cancel: "🚫 Отменено", seen: "👀 Увидено", record_blocker: "🧱 Блокер записан" },
  uk: { done: "✅ Виконано", start: "▶️ Розпочато", skip: "⏭ Пропущено", cancel: "🚫 Скасовано", seen: "👀 Побачено", record_blocker: "🧱 Блокер записано" },
  en: { done: "✅ Done", start: "▶️ Started", skip: "⏭ Skipped", cancel: "🚫 Cancelled", seen: "👀 Seen", record_blocker: "🧱 Blocker recorded" },
};

const SERIES_LABELS: Record<ReportLocale, Record<Extract<AppliedReportItem, { kind: "series" }>["operation"], string>> = {
  ru: { pause: "приостановлена", resume: "возобновлена", stop: "остановлена, текущая задача остаётся", cancel: "отменена", edit: "расписание изменено" },
  uk: { pause: "призупинена", resume: "відновлена", stop: "зупинена, поточне завдання лишається", cancel: "скасована", edit: "розклад змінено" },
  en: { pause: "paused", resume: "resumed", stop: "stopped, the current task stays", cancel: "cancelled", edit: "schedule changed" },
};

const SETTINGS_LABELS: Record<ReportLocale, Record<Extract<AppliedReportItem, { kind: "settings" }>["operation"], string>> = {
  ru: {
    timezone: "часовой пояс",
    language: "язык интерфейса",
    digest: "сводка",
    weekly_review: "недельный обзор",
    quiet_hours: "тихие часы",
    snooze: "пауза уведомлений",
    reminder_defaults: "напоминания по умолчанию",
  },
  uk: {
    timezone: "часовий пояс",
    language: "мова інтерфейсу",
    digest: "зведення",
    weekly_review: "тижневий огляд",
    quiet_hours: "тихі години",
    snooze: "пауза сповіщень",
    reminder_defaults: "нагадування за замовчуванням",
  },
  en: {
    timezone: "timezone",
    language: "interface language",
    digest: "briefing",
    weekly_review: "weekly review",
    quiet_hours: "quiet hours",
    snooze: "notification pause",
    reminder_defaults: "default reminders",
  },
};

const COPY: Record<
  ReportLocale,
  {
    tasksCreated: string;
    taskCreated: string;
    taskUpdated: string;
    taskUpdatedNoChanges: string;
    rescheduled: string;
    reason: string;
    noReminders: string;
    reminder: string;
    reminderAdded: string;
    series: string;
    goalCreated: string;
    goalUpdated: string;
    goalPlan: string;
    goalUnlinked: string;
    memorySaved: string;
    memoryUpdated: string;
    memoryDeleted: string;
    settings: string;
    goal: string;
    review: string;
    noReminder: string;
    atStart: string;
    removed: string;
    itemsDone: string;
    habitOn: string;
    habitOff: string;
  }
> = {
  ru: {
    tasksCreated: "✅ Создано задач: {n}",
    taskCreated: "✅ Создана задача «{title}»",
    taskUpdated: "✏️ Задача «{title}»",
    taskUpdatedNoChanges: "✏️ Задача «{title}» обновлена",
    rescheduled: "📅 Перенесено «{title}»",
    reason: "Причина",
    noReminders: "🔕 Напоминаний для «{title}» больше нет",
    reminder: "🔔 Напоминание «{title}»",
    reminderAdded: " (добавлено к остальным)",
    series: "🔁 Серия «{title}»",
    goalCreated: "🎯 Цель создана: «{title}»",
    goalUpdated: "🎯 Цель обновлена: «{title}»",
    goalPlan: "🎯 Цель «{title}» и задач к ней: {n}",
    goalUnlinked: "🎯 Отвязано от цели «{goal}»: «{task}»",
    memorySaved: "🧠 Запомнил",
    memoryUpdated: "🧠 Обновил в памяти",
    memoryDeleted: "🧠 Убрал из памяти",
    settings: "⚙️ Настройки обновлены",
    goal: "🎯 Цель",
    review: "пересмотр",
    noReminder: "🔕 без напоминания",
    atStart: "в момент начала",
    removed: "убрано",
    itemsDone: "выполнено",
    habitOn: "включён",
    habitOff: "выключен",
  },
  uk: {
    tasksCreated: "✅ Створено завдань: {n}",
    taskCreated: "✅ Створено завдання «{title}»",
    taskUpdated: "✏️ Завдання «{title}»",
    taskUpdatedNoChanges: "✏️ Завдання «{title}» оновлено",
    rescheduled: "📅 Перенесено «{title}»",
    reason: "Причина",
    noReminders: "🔕 Нагадувань для «{title}» більше немає",
    reminder: "🔔 Нагадування «{title}»",
    reminderAdded: " (додано до решти)",
    series: "🔁 Серія «{title}»",
    goalCreated: "🎯 Ціль створено: «{title}»",
    goalUpdated: "🎯 Ціль оновлено: «{title}»",
    goalPlan: "🎯 Ціль «{title}» і завдань до неї: {n}",
    goalUnlinked: "🎯 Відв'язано від цілі «{goal}»: «{task}»",
    memorySaved: "🧠 Запам'ятав",
    memoryUpdated: "🧠 Оновив у пам'яті",
    memoryDeleted: "🧠 Прибрав із пам'яті",
    settings: "⚙️ Налаштування оновлено",
    goal: "🎯 Ціль",
    review: "перегляд",
    noReminder: "🔕 без нагадування",
    atStart: "у момент початку",
    removed: "прибрано",
    itemsDone: "виконано",
    habitOn: "увімкнено",
    habitOff: "вимкнено",
  },
  en: {
    tasksCreated: "✅ Tasks created: {n}",
    taskCreated: "✅ Task created: “{title}”",
    taskUpdated: "✏️ Task “{title}”",
    taskUpdatedNoChanges: "✏️ Task “{title}” updated",
    rescheduled: "📅 Moved “{title}”",
    reason: "Reason",
    noReminders: "🔕 No more reminders for “{title}”",
    reminder: "🔔 Reminder for “{title}”",
    reminderAdded: " (added to the others)",
    series: "🔁 Series “{title}”",
    goalCreated: "🎯 Goal created: “{title}”",
    goalUpdated: "🎯 Goal updated: “{title}”",
    goalPlan: "🎯 Goal “{title}” with {n} tasks",
    goalUnlinked: "🎯 Unlinked from goal “{goal}”: “{task}”",
    memorySaved: "🧠 Remembered",
    memoryUpdated: "🧠 Updated in memory",
    memoryDeleted: "🧠 Removed from memory",
    settings: "⚙️ Settings updated",
    goal: "🎯 Goal",
    review: "review",
    noReminder: "🔕 no reminder",
    atStart: "at the start",
    removed: "removed",
    itemsDone: "done",
    habitOn: "on",
    habitOff: "off",
  },
};

const fill = (template: string, params: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/gu, (match, name: string) => (name in params ? String(params[name]) : match));

/** Diff of the stored mutable task fields, in the order the user reads them. */
/**
 * Values are stored locale-neutral (enum keys, `checklist:total:done`, `on`/`off`) because the
 * diff is computed inside the write transaction; `renderAppliedReport` words them for the reader.
 */
export function taskFieldChanges(before: Record<string, unknown>, after: Record<string, unknown>): TaskFieldChange[] {
  const changes: TaskFieldChange[] = [];
  for (const field of Object.keys(FIELD_LABELS.ru) as TaskFieldChange["field"][]) {
    const previous = describeFieldValue(field, before[field]);
    const next = describeFieldValue(field, after[field]);
    if (previous !== next) changes.push({ field, before: previous, after: next });
  }
  return changes;
}

function describeFieldValue(field: TaskFieldChange["field"], value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (field === "checklist") {
    if (!Array.isArray(value)) return null;
    const done = value.filter((item) => item && typeof item === "object" && (item as { done?: boolean }).done).length;
    return value.length ? `checklist:${value.length}:${done}` : null;
  }
  if (field === "habitMode") return value === true ? "on" : value === false ? "off" : null;
  if (field === "importance") return typeof value === "string" ? value : String(value);
  if (typeof value === "string") return value.trim() || null;
  return String(value);
}

export function renderAppliedReport(items: readonly AppliedReportItem[], now: Date, locale: ReportLocale = "ru"): string {
  const blocks: string[] = [];
  const copy = COPY[locale];
  const createdTasks = items.filter((item): item is Extract<AppliedReportItem, { kind: "task_created" }> => item.kind === "task_created");
  if (createdTasks.length === 1) blocks.push(renderCreatedTask(createdTasks[0]!, now, locale));
  if (createdTasks.length > 1) {
    blocks.push(
      [fill(copy.tasksCreated, { n: createdTasks.length }), ...createdTasks.map((task, index) => `${index + 1}. ${renderCreatedTaskLine(task, now, locale)}`)].join("\n"),
    );
  }
  for (const item of items) {
    if (item.kind === "task_created") continue;
    const block = renderItem(item, now, locale);
    if (block) blocks.push(block);
  }
  return blocks.join("\n\n");
}

function renderItem(item: Exclude<AppliedReportItem, { kind: "task_created" }>, now: Date, locale: ReportLocale): string | null {
  const copy = COPY[locale];
  switch (item.kind) {
    case "task_updated": {
      const head = fill(copy.taskUpdated, { title: item.title });
      if (!item.changes.length) return fill(copy.taskUpdatedNoChanges, { title: item.title });
      const lines = item.changes.map((change) => `• ${FIELD_LABELS[locale][change.field]}: ${renderChange(change, locale)}`);
      return [head, ...lines].join("\n");
    }
    case "task_rescheduled": {
      const before = item.before ? scheduleLabel(item.before, now, locale) : null;
      const after = item.after ? scheduleLabel(item.after, now, locale) : null;
      const timezone = item.after?.timezone ?? item.before?.timezone;
      const head = `${fill(copy.rescheduled, { title: item.title })}: ${before ?? "—"} → ${after ?? "—"}${timezone ? ` (${timezone})` : ""}`;
      const extras: string[] = [];
      if (item.reminderAt && item.after) extras.push(`🔔 ${reminderLabel(item.reminderAt, item.after, now, locale)}`);
      if (item.reason?.trim()) extras.push(`${copy.reason}: ${item.reason.trim()}`);
      return extras.length ? `${head}\n${extras.join("\n")}` : head;
    }
    case "occurrence":
      return `${OCCURRENCE_LABELS[locale][item.operation]}: «${item.title}»${item.operation === "record_blocker" && item.details?.trim() ? ` — ${item.details.trim()}` : ""}`;
    case "reminder": {
      if (item.mode === "clear" || !item.reminderAt) return fill(copy.noReminders, { title: item.title });
      const timezone = item.schedule?.timezone;
      const when = item.schedule
        ? reminderLabel(item.reminderAt, item.schedule, now, locale, true)
        : formatLocalDateTime(item.reminderAt, timezone ?? "UTC", now, intlLocale(locale));
      return `${fill(copy.reminder, { title: item.title })}: ${when}${timezone ? ` (${timezone})` : ""}${item.mode === "add" ? copy.reminderAdded : ""}`;
    }
    case "series":
      return `${fill(copy.series, { title: item.title })}: ${SERIES_LABELS[locale][item.operation]}`;
    case "goal_created":
      return fill(copy.goalCreated, { title: item.title });
    case "goal_updated":
      return fill(copy.goalUpdated, { title: item.title });
    case "goal_plan":
      return [
        fill(copy.goalPlan, { title: item.goalTitle, n: item.tasks.length }),
        ...item.tasks.map((task, index) => `${index + 1}. ${renderCreatedTaskLine(task, now, locale)}`),
      ].join("\n");
    case "goal_linked":
      return `🔗 «${item.taskTitle}» → ${copy.goal.replace("🎯 ", "").toLocaleLowerCase()} «${item.goalTitle}»`;
    case "goal_unlinked":
      return fill(copy.goalUnlinked, { goal: item.goalTitle, task: item.taskTitle });
    case "memory":
      return `${item.operation === "saved" ? copy.memorySaved : item.operation === "updated" ? copy.memoryUpdated : copy.memoryDeleted}: «${truncate(item.content, 120)}»`;
    case "settings":
      return `${copy.settings}: ${SETTINGS_LABELS[locale][item.operation]}`;
    case "generic":
      return `✅ ${item.title}`;
    default:
      return null;
  }
}

function renderCreatedTask(task: Extract<AppliedReportItem, { kind: "task_created" }>, now: Date, locale: ReportLocale): string {
  const copy = COPY[locale];
  const lines = [`${fill(copy.taskCreated, { title: task.title })}${taskBadges(task)}`];
  const when = createdWhen(task, now, locale);
  if (when) lines.push(when);
  if (task.goalTitle) lines.push(`${copy.goal}: «${task.goalTitle}»`);
  return lines.join("\n");
}

function renderCreatedTaskLine(task: Extract<AppliedReportItem, { kind: "task_created" }>, now: Date, locale: ReportLocale): string {
  const when = createdWhen(task, now, locale);
  const goal = task.goalTitle ? ` · 🎯 «${task.goalTitle}»` : "";
  return `«${task.title}»${taskBadges(task)}${when ? ` — ${when}` : ""}${goal}`;
}

function taskBadges(task: Extract<AppliedReportItem, { kind: "task_created" }>): string {
  const badges = [task.importance === "critical" ? "🔴" : task.importance === "required" ? "🟡" : "", task.recurring ? "🔁" : ""].filter(Boolean);
  return badges.length ? ` ${badges.join("")}` : "";
}

function createdWhen(task: Extract<AppliedReportItem, { kind: "task_created" }>, now: Date, locale: ReportLocale): string | null {
  const copy = COPY[locale];
  if (task.schedule) {
    const reminder = task.reminderAt ? `🔔 ${reminderLabel(task.reminderAt, task.schedule, now, locale)}` : copy.noReminder;
    return `📅 ${scheduleLabel(task.schedule, now, locale)} (${task.schedule.timezone}) · ${reminder}`;
  }
  if (task.fuzzyHorizonText) {
    const review = task.reviewAt ? ` · ${copy.review} ${formatLocalDateTime(task.reviewAt, task.timezone, now, intlLocale(locale))}` : "";
    return `🫧 ${task.fuzzyHorizonText}${review} (${task.timezone})`;
  }
  return null;
}

function renderChange(change: TaskFieldChange, locale: ReportLocale): string {
  const before = change.before === null ? null : renderValue(change.field, change.before, locale);
  const after = change.after === null ? null : renderValue(change.field, change.after, locale);
  if (before === null) return `«${after ?? ""}»`;
  if (after === null) return `«${before}» → ${COPY[locale].removed}`;
  return `«${before}» → «${after}»`;
}

function renderValue(field: TaskFieldChange["field"], value: string, locale: ReportLocale): string {
  const copy = COPY[locale];
  if (field === "importance" && value in IMPORTANCE_LABELS[locale]) return IMPORTANCE_LABELS[locale][value as Importance];
  if (field === "habitMode") return value === "on" ? copy.habitOn : value === "off" ? copy.habitOff : value;
  if (field === "checklist") {
    const match = /^checklist:(\d+):(\d+)$/u.exec(value);
    if (match) {
      const total = Number(match[1]);
      const done = Number(match[2]);
      return `${total} ${plural(locale, total, "пункт", "пункта", "пунктов", "пункт", "пункти", "пунктів", "item", "items")}${done ? `, ${copy.itemsDone} ${done}` : ""}`;
    }
  }
  return value;
}

/** Reminder relative to the displayed anchor: same minute, same day, or a full timestamp. */
function reminderLabel(reminderAt: Date, schedule: OccurrenceScheduleView, now: Date, locale: ReportLocale, alwaysFull = false): string {
  const anchor = schedule.plannedStartAt ?? schedule.dueAt ?? schedule.plannedEndAt;
  if (!alwaysFull && anchor && Math.floor(anchor.getTime() / 60_000) === Math.floor(reminderAt.getTime() / 60_000)) return COPY[locale].atStart;
  const anchorDate = anchor ? localDateAt(anchor, schedule.timezone) : (schedule.plannedLocalDate ?? schedule.dueLocalDate);
  if (!alwaysFull && anchorDate && localDateAt(reminderAt, schedule.timezone) === anchorDate) return formatLocalTime(reminderAt, schedule.timezone, intlLocale(locale));
  return formatLocalDateTime(reminderAt, schedule.timezone, now, intlLocale(locale));
}

function truncate(value: string, max: number): string {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function plural(
  locale: ReportLocale,
  count: number,
  ruOne: string,
  ruFew: string,
  ruMany: string,
  ukOne: string,
  ukFew: string,
  ukMany: string,
  enOne: string,
  enMany: string,
): string {
  if (locale === "en") return count === 1 ? enOne : enMany;
  const [one, few, many] = locale === "uk" ? [ukOne, ukFew, ukMany] : [ruOne, ruFew, ruMany];
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
