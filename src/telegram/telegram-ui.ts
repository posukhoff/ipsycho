import { InlineKeyboard } from "grammy";
import { compactText } from "../core/telegram-ux.js";
import { localDateAt } from "../core/timezone.js";
import { formatLocalDateTime } from "../core/time-presentation.js";
import { recurrenceLabel } from "../core/recurrence-label.js";
import { selectCardDetails } from "../core/card-details.js";
import { t } from "./copy/index.js";
import type { TelegramLocale } from "./telegram-locale.js";

export type TelegramImportance = "normal" | "required" | "critical";
export type TelegramOccurrenceStatus = "scheduled" | "open" | "in_progress" | "done" | "skipped" | "cancelled" | "elapsed";

export interface TelegramTaskCard {
  title: string;
  importance: TelegramImportance;
  kind?: "task" | "event";
  recurrenceRule?: string | null;
  recurrenceEndLocalDate?: string | null;
  fuzzyHorizonText?: string | null;
  reviewAt?: Date | string | null;
  timezone: string;
  /** Optional detail fields; a card shows only those that are present. */
  why?: string | null;
  nextAction?: string | null;
  context?: string | null;
  checklist?: ReadonlyArray<{ text: string; done: boolean }> | null;
  goalTitle?: string | null;
  nextReminderAt?: Date | string | null;
}

export interface TelegramOccurrenceCard {
  id: string;
  status: TelegramOccurrenceStatus;
  timezone: string;
  plannedStartAt?: Date | string | null;
  plannedEndAt?: Date | string | null;
  plannedLocalDate?: string | null;
  dueAt?: Date | string | null;
  dueLocalDate?: string | null;
  overdue?: boolean;
  completedAt?: Date | string | null;
}

export type TelegramTaskListRow = { task: TelegramTaskCard & { id: string }; occurrence: TelegramOccurrenceCard | null };

export function taskCardText(task: TelegramTaskCard, occurrence: TelegramOccurrenceCard, now: Date = new Date()): string {
  const title = `${importanceIcon(task.importance)} ${task.title}`.trim();
  const head = [title];
  const when = scheduleLine(task, occurrence, now);
  if (when) head.push(when);
  const recurrence = recurrenceLabel(task.recurrenceRule, task.recurrenceEndLocalDate);
  if (recurrence) head.push(`🔁 ${recurrence}`);
  const state = occurrence.status === "in_progress" ? "▶️ В работе"
    : occurrence.overdue ? `⚠️ Просрочено${overdueFor(occurrence, now)}`
    : occurrence.status === "scheduled" ? "" : "";
  if (state) head.push(state);
  const details = detailLines(task);
  return details.length ? `${head.join("\n")}\n\n${details.join("\n")}` : head.join("\n");
}

export function fuzzyTaskCardText(task: TelegramTaskCard, now: Date = new Date()): string {
  const title = `${importanceIcon(task.importance)} ${task.title}`.trim();
  const horizon = task.fuzzyHorizonText ? `🫧 ${task.fuzzyHorizonText}` : "🫧 Без точной даты";
  const review = task.reviewAt ? `🗓 Вернуться: ${formatLocalDateTime(new Date(task.reviewAt), task.timezone, now)} (${task.timezone})` : "";
  const head = [title, horizon, review].filter(Boolean);
  const details = detailLines(task);
  return details.length ? `${head.join("\n")}\n\n${details.join("\n")}` : head.join("\n");
}

export function reminderCardText(input: {
  task: TelegramTaskCard;
  occurrence?: TelegramOccurrenceCard | null;
  purpose: "user_reminder" | "planning_review" | "follow_up";
  now: Date;
}): string {
  const icon = input.purpose === "planning_review" ? "🗓" : input.purpose === "follow_up" ? "↩️" : "🔔";
  const title = `${icon} ${importanceIcon(input.task.importance)} ${input.task.title}`.replace(/\s+/g, " ").trim();
  const prompt = input.purpose === "planning_review" ? "Пора решить, когда вернуться к задаче."
    : input.purpose === "follow_up" && input.occurrence?.status === "in_progress" ? "Как идёт?" : "";
  const lines = [title];
  if (input.occurrence) {
    const when = scheduleLine(input.task, input.occurrence, input.now, relativeDue(input.occurrence, input.now));
    if (when) lines.push(when);
  } else if (input.task.fuzzyHorizonText) {
    lines.push(`🫧 ${input.task.fuzzyHorizonText}`);
  }
  const recurrence = recurrenceLabel(input.task.recurrenceRule, input.task.recurrenceEndLocalDate);
  if (recurrence) lines.push(`🔁 ${recurrence}`);
  // At the moment of the reminder the next concrete step matters more than the rationale.
  const details = selectCardDetails(input.task);
  if (details.nextAction) lines.push(`➡️ ${compactText(details.nextAction, 300)}`);
  if (details.context) lines.push(`📝 ${compactText(details.context, 200)}`);
  const checklist = checklistLines(input.task.checklist, 3);
  if (checklist.length) lines.push(...checklist);
  if (prompt) lines.push("", prompt);
  return lines.join("\n").trimEnd();
}

/** One line with the persisted time of an occurrence: start(–end) / deadline / date, plus the next reminder. */
function scheduleLine(task: TelegramTaskCard, occurrence: TelegramOccurrenceCard, now: Date, relative = ""): string {
  const when = occurrenceWhen(occurrence, now);
  if (!when) return "";
  const reminder = task.nextReminderAt ? ` · 🔔 ${reminderTimeLabel(new Date(task.nextReminderAt), occurrence, now)}` : "";
  const suffix = relative ? ` · ${relative}` : "";
  return `📅 ${when} (${occurrence.timezone})${reminder}${suffix}`;
}

function occurrenceWhen(occurrence: TelegramOccurrenceCard, now: Date): string {
  const tz = occurrence.timezone;
  if (occurrence.plannedStartAt && occurrence.plannedEndAt) {
    const start = new Date(occurrence.plannedStartAt);
    const end = new Date(occurrence.plannedEndAt);
    const endLabel = localDateAt(start, tz) === localDateAt(end, tz) ? formatTime(end, tz) : formatLocalDateTime(end, tz, now);
    return `${formatLocalDateTime(start, tz, now)}–${endLabel}`;
  }
  if (occurrence.plannedStartAt) return formatLocalDateTime(new Date(occurrence.plannedStartAt), tz, now);
  if (occurrence.dueAt) return `до ${formatLocalDateTime(new Date(occurrence.dueAt), tz, now)}`;
  if (occurrence.plannedLocalDate) return formatDateLabel(occurrence.plannedLocalDate, tz, now);
  if (occurrence.dueLocalDate) return `до ${formatDateLabel(occurrence.dueLocalDate, tz, now)}`;
  return "";
}

function reminderTimeLabel(reminderAt: Date, occurrence: TelegramOccurrenceCard, now: Date): string {
  const anchor = occurrence.plannedStartAt ? new Date(occurrence.plannedStartAt) : occurrence.dueAt ? new Date(occurrence.dueAt) : null;
  if (anchor && localDateAt(anchor, occurrence.timezone) === localDateAt(reminderAt, occurrence.timezone)) return formatTime(reminderAt, occurrence.timezone);
  return formatLocalDateTime(reminderAt, occurrence.timezone, now);
}

function overdueFor(occurrence: TelegramOccurrenceCard, now: Date): string {
  const target = occurrence.dueAt ? new Date(occurrence.dueAt) : occurrence.plannedStartAt ? new Date(occurrence.plannedStartAt) : null;
  if (!target) return "";
  const minutes = Math.round((now.getTime() - target.getTime()) / 60_000);
  if (minutes < 1) return "";
  if (minutes < 60) return ` на ${minutes} мин`;
  if (minutes < 48 * 60) return ` на ${Math.round(minutes / 60)} ч`;
  return ` на ${Math.round(minutes / (24 * 60))} дн`;
}

/** Detail lines in reading order; fields that only repeat the title, goal or checklist are dropped (see selectCardDetails). */
function detailLines(task: TelegramTaskCard): string[] {
  const lines: string[] = [];
  const details = selectCardDetails(task);
  if (details.why) lines.push(`💡 Зачем: ${compactText(details.why, 300)}`);
  if (details.nextAction) lines.push(`➡️ Следующий шаг: ${compactText(details.nextAction, 300)}`);
  if (details.context) lines.push(`📝 ${compactText(details.context, 400)}`);
  lines.push(...checklistLines(task.checklist, 12));
  if (task.goalTitle?.trim()) lines.push(`🎯 Цель: «${task.goalTitle.trim()}»`);
  return lines;
}

function checklistLines(checklist: TelegramTaskCard["checklist"], limit: number): string[] {
  if (!checklist?.length) return [];
  const done = checklist.filter((item) => item.done).length;
  const lines = [`☑️ Чеклист ${done}/${checklist.length}`];
  for (const item of checklist.slice(0, limit)) lines.push(`${item.done ? "✅" : "◻️"} ${compactText(item.text, 120)}`);
  if (checklist.length > limit) lines.push(`… ещё ${checklist.length - limit}`);
  return lines;
}

export interface TaskKeyboardOptions {
  /** A reminder card offers to be repeated later without touching the task's own time. */
  snooze?: boolean;
}

export function taskKeyboard(occurrenceId: string, status: TelegramOccurrenceStatus, locale: TelegramLocale = "ru", options: TaskKeyboardOptions = {}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (status === "in_progress") return startedTaskKeyboard(occurrenceId, locale, options);
  keyboard.text(label(locale, "start"), `occ:start:${occurrenceId}`).text(label(locale, "done"), `occ:done:${occurrenceId}`).row();
  if (options.snooze) keyboard.text(t(locale, "snooze_15m_button"), `follow:seen:15m:${occurrenceId}`).text(t(locale, "snooze_1h_button"), `follow:seen:1h:${occurrenceId}`).row();
  keyboard.text(label(locale, "later"), `occ:resched:${occurrenceId}`).text(label(locale, "more"), `occ:more:${occurrenceId}`);
  return keyboard;
}

export function startedTaskKeyboard(occurrenceId: string, locale: TelegramLocale = "ru", options: TaskKeyboardOptions = {}): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text(label(locale, "done"), `occ:done:${occurrenceId}`)
    .text(label(locale, "later"), `occ:resched:${occurrenceId}`)
    .row();
  if (options.snooze) keyboard.text(t(locale, "snooze_15m_button"), `follow:seen:15m:${occurrenceId}`).text(t(locale, "snooze_1h_button"), `follow:seen:1h:${occurrenceId}`).row();
  return keyboard.text(label(locale, "stuck"), `occ:cant:${occurrenceId}`).text(label(locale, "more"), `occ:more:${occurrenceId}`);
}

/** The destructive actions live one tap deeper, behind an explicit label rather than "•••". */
export function taskMoreKeyboard(occurrenceId: string, status: TelegramOccurrenceStatus, recurring = false, taskId?: string, locale: TelegramLocale = "ru"): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (status === "in_progress") keyboard.text(label(locale, "check"), `occ:check:${occurrenceId}`).row();
  if (recurring) keyboard.text(label(locale, "skip"), `occ:skip:${occurrenceId}`).row();
  if (recurring && taskId) keyboard.text(label(locale, "pauseSeries"), `series:pause:${taskId}`).row();
  if (status !== "in_progress") keyboard.text(label(locale, "stuck"), `occ:cant:${occurrenceId}`).row();
  return keyboard
    .text(label(locale, "cancel"), `occ:cancel:${occurrenceId}`)
    .row()
    .text(t(locale, "back_button"), `occ:back:${occurrenceId}`);
}

export function quickRescheduleKeyboard(occurrenceId: string, locale: TelegramLocale = "ru"): InlineKeyboard {
  return new InlineKeyboard()
    .text(label(locale, "plusHour"), `resched:1h:${occurrenceId}`)
    .text(label(locale, "evening"), `resched:evening:${occurrenceId}`)
    .row()
    .text(label(locale, "tomorrow"), `resched:tomorrow:${occurrenceId}`)
    .text(label(locale, "otherDate"), `resched:custom:${occurrenceId}`)
    .row()
    .text(t(locale, "back_button"), `occ:back:${occurrenceId}`);
}


export type QuickRescheduleReasonCode = "time" | "dependency" | "energy" | "other";

export function quickRescheduleReasonKeyboard(occurrenceId: string, choice: "1h" | "evening" | "tomorrow", locale: TelegramLocale = "ru"): InlineKeyboard {
  const choiceCode = choice === "1h" ? "h" : choice === "evening" ? "e" : "t";
  return new InlineKeyboard()
    .text(quickRescheduleReasonText("time", locale) ?? "", `rr:${choiceCode}:t:${occurrenceId}`)
    .text(quickRescheduleReasonText("dependency", locale) ?? "", `rr:${choiceCode}:d:${occurrenceId}`)
    .row()
    .text(quickRescheduleReasonText("energy", locale) ?? "", `rr:${choiceCode}:e:${occurrenceId}`)
    .text(label(locale, "other"), `rr:${choiceCode}:o:${occurrenceId}`)
    .row()
    .text(t(locale, "back_button"), `occ:resched:${occurrenceId}`);
}

export function quickRescheduleReasonText(code: QuickRescheduleReasonCode, locale: TelegramLocale = "ru"): string | null {
  if (code === "time") return label(locale, "reasonTime");
  if (code === "dependency") return label(locale, "reasonDependency");
  if (code === "energy") return label(locale, "reasonEnergy");
  return null;
}

export function resultCheckKeyboard(occurrenceId: string, locale: TelegramLocale = "ru"): InlineKeyboard {
  return new InlineKeyboard()
    .text(label(locale, "in15"), `follow:result:15m:${occurrenceId}`)
    .text(label(locale, "in1h"), `follow:result:1h:${occurrenceId}`)
    .row()
    .text(label(locale, "evening"), `follow:result:evening:${occurrenceId}`)
    .text(label(locale, "noCheck"), `follow:result:none:${occurrenceId}`)
    .row()
    .text(t(locale, "back_button"), `occ:back:${occurrenceId}`);
}

const BUTTON_LABELS = {
  ru: { start: "▶️ Начать", done: "✅ Готово", later: "🕒 Позже", more: "⚙️ Ещё", stuck: "🧱 Застрял", check: "🔔 Проверить", skip: "⏭ Пропустить это", pauseSeries: "⏸ Поставить серию на паузу", cancel: "❌ Отменить задачу", plusHour: "+1 час", evening: "Вечером", tomorrow: "Завтра", otherDate: "📅 Другая дата", other: "Другое", reasonTime: "Не успеваю", reasonDependency: "Зависит от другого", reasonEnergy: "Нет сил", in15: "Через 15 мин", in1h: "Через 1 час", noCheck: "Без проверки" },
  uk: { start: "▶️ Почати", done: "✅ Готово", later: "🕒 Пізніше", more: "⚙️ Ще", stuck: "🧱 Застряг", check: "🔔 Перевірити", skip: "⏭ Пропустити це", pauseSeries: "⏸ Поставити серію на паузу", cancel: "❌ Скасувати завдання", plusHour: "+1 година", evening: "Увечері", tomorrow: "Завтра", otherDate: "📅 Інша дата", other: "Інше", reasonTime: "Не встигаю", reasonDependency: "Залежить від іншого", reasonEnergy: "Немає сил", in15: "Через 15 хв", in1h: "Через 1 годину", noCheck: "Без перевірки" },
  en: { start: "▶️ Start", done: "✅ Done", later: "🕒 Later", more: "⚙️ More", stuck: "🧱 Stuck", check: "🔔 Check", skip: "⏭ Skip this one", pauseSeries: "⏸ Pause the series", cancel: "❌ Cancel the task", plusHour: "+1 hour", evening: "This evening", tomorrow: "Tomorrow", otherDate: "📅 Another date", other: "Other", reasonTime: "Out of time", reasonDependency: "Depends on something", reasonEnergy: "No energy", in15: "In 15 min", in1h: "In 1 hour", noCheck: "No check" },
} as const;

function label(locale: TelegramLocale, key: keyof typeof BUTTON_LABELS["ru"]): string {
  return BUTTON_LABELS[locale][key];
}

export function terminalTaskText(task: TelegramTaskCard, status: "done" | "skipped" | "cancelled", now: Date, locale: TelegramLocale = "ru"): string {
  if (status === "done") return `✅ ${task.title}\n${t(locale, "done_toast")} · ${formatTime(now, task.timezone)}`;
  if (status === "skipped") return `⏭ ${task.title}\n${t(locale, "skipped_toast")}`;
  return `❌ ${task.title}\n${t(locale, "cancelled_occurrence_toast")}`;
}

export function settingsText(row: {
  timezone: string;
  morningDigestEnabled: boolean;
  morningReferenceTime: string;
  eveningDigestEnabled: boolean;
  eveningReferenceTime: string;
  weeklyReviewEnabled: boolean;
  weeklyReviewWeekday: number;
  weeklyReviewTime: string;
  quietHoursEnabled: boolean;
  weekdayQuietStart: string;
  weekdayQuietEnd: string;
  weekendQuietStart?: string | null;
  weekendQuietEnd?: string | null;
  pinnedLanguage?: string | null;
  notificationsSnoozedUntil?: Date | null;
}, now = new Date(), historyMessageCount = 0, locale: TelegramLocale = "ru"): string {
  if (locale === "en") {
    const snoozed = row.notificationsSnoozedUntil && row.notificationsSnoozedUntil > now ? `\n🔕 Quiet until ${formatLocal(row.notificationsSnoozedUntil, row.timezone)}` : "";
    return [
      "⚙️ Settings", "",
      `🌍 Timezone: ${row.timezone}${snoozed}`,
      `🗣 Interface language: ${row.pinnedLanguage ?? "automatic (Telegram)"}`,
      `☀️ Morning briefing: ${row.morningDigestEnabled ? row.morningReferenceTime : "off"}`,
      `🌙 Evening briefing: ${row.eveningDigestEnabled ? row.eveningReferenceTime : "off"}`,
      `📅 Weekly review: ${row.weeklyReviewEnabled ? `${weekdayLabel(row.weeklyReviewWeekday, locale)} ${row.weeklyReviewTime}` : "off"}`,
      `🔕 Quiet hours: ${quietHoursLabel(row, locale)}`,
      `💬 AI history: ${historyMessageCount} ${messageWord(historyMessageCount, locale)}`,
      "", "Describe what you want to change: briefing time, weekly-review day, language, or quiet hours.",
    ].join("\n");
  }
  const uk = locale === "uk";
  const snoozed = row.notificationsSnoozedUntil && row.notificationsSnoozedUntil > now
    ? `\n🔕 ${locale === "uk" ? "Тиша до" : "Тишина до"} ${formatLocal(row.notificationsSnoozedUntil, row.timezone)}`
    : "";
  return [
    uk ? "⚙️ Налаштування" : "⚙️ Настройки",
    "",
    `${uk ? "🌍 Часовий пояс" : "🌍 Часовой пояс"}: ${row.timezone}${snoozed}`,
    `${uk ? "🗣 Мова інтерфейсу" : "🗣 Язык интерфейса"}: ${row.pinnedLanguage ?? (uk ? "автоматично (Telegram)" : "автоматически (Telegram)")}`,
    `${uk ? "☀️ Ранкове зведення" : "☀️ Утренняя сводка"}: ${row.morningDigestEnabled ? row.morningReferenceTime : (uk ? "вимкнено" : "выкл")}`,
    `${uk ? "🌙 Вечірнє зведення" : "🌙 Вечерняя сводка"}: ${row.eveningDigestEnabled ? row.eveningReferenceTime : (uk ? "вимкнено" : "выкл")}`,
    `${uk ? "📅 Щотижневий огляд" : "📅 Еженедельный обзор"}: ${row.weeklyReviewEnabled ? `${weekdayLabel(row.weeklyReviewWeekday, locale)} ${row.weeklyReviewTime}` : (uk ? "вимкнено" : "выкл")}`,
    `${uk ? "🔕 Тихі години" : "🔕 Тихие часы"}: ${quietHoursLabel(row, locale)}`,
    `${uk ? "💬 Історія AI" : "💬 История AI"}: ${historyMessageCount} ${messageWord(historyMessageCount, locale)}`,
    "",
    uk ? "Опиши бажаний результат: час зведень, день тижневого огляду, мову чи тихі години." : "Опиши желаемый результат: время сводок, день еженедельного обзора, язык или тихие часы.",
  ].join("\n");
}

/** Every toggle the settings card shows is one tap; free text remains for values (times, days). */
export function settingsKeyboard(locale: TelegramLocale = "ru", row?: { morningDigestEnabled: boolean; eveningDigestEnabled: boolean; weeklyReviewEnabled: boolean; quietHoursEnabled: boolean }): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (row) {
    keyboard
      .text(t(locale, row.morningDigestEnabled ? "prefs_morning_on" : "prefs_morning_off"), "prefs:morning:toggle")
      .text(t(locale, row.eveningDigestEnabled ? "prefs_evening_on" : "prefs_evening_off"), "prefs:evening:toggle")
      .row()
      .text(t(locale, row.weeklyReviewEnabled ? "prefs_weekly_on" : "prefs_weekly_off"), "prefs:weekly:toggle")
      .text(t(locale, row.quietHoursEnabled ? "prefs_quiet_on" : "prefs_quiet_off"), "prefs:quiet:toggle")
      .row();
  }
  return keyboard
    .text(t(locale, "prefs_snooze_morning"), "prefs:snooze:morning")
    .text(t(locale, "prefs_weekly_start"), "review:weekly:start")
    .row()
    .text(t(locale, "prefs_context"), "profile:open")
    .text(t(locale, "prefs_clear_history"), "history:clear")
    .row()
    .text(t(locale, "today_button"), "nav:today")
    .text(t(locale, "tasks_button"), "nav:tasks");
}

export function tasksOverviewText(rows: Array<{ task: TelegramTaskCard & { id: string }; occurrence: TelegramOccurrenceCard | null }>, locale: TelegramLocale = "ru", now: Date = new Date()): string {
  // The overview is task-oriented: a recurring task may have many future
  // occurrences, but it must appear only once here. The Today screen below is
  // occurrence-oriented and intentionally keeps every same-day instance.
  const uniqueRows = rows.filter((row, index) => rows.findIndex((candidate) => candidate.task.id === row.task.id) === index);
  if (locale === "en") {
    if (!uniqueRows.length) return "📋 Tasks\n\nNo active tasks.";
    const lines = ["📋 Tasks", ""];
    for (const [index, row] of uniqueRows.slice(0, 8).entries()) {
      const icon = importanceIcon(row.task.importance) || (row.task.recurrenceRule ? "🔁" : row.occurrence ? "•" : "🫧");
      const state = row.occurrence?.overdue ? " · overdue" : row.occurrence?.status === "in_progress" ? " · in progress" : "";
      lines.push(`${index + 1}. ${icon} ${row.task.title}${overviewWhen(row.task, row.occurrence, now)}${state}`);
    }
    if (uniqueRows.length > 8) lines.push(`+ ${uniqueRows.length - 8} more`);
    lines.push("", "To change, complete, or reschedule a task, just write it in a message.");
    return lines.join("\n");
  }
  const uk = locale === "uk";
  if (!uniqueRows.length) return uk ? "📋 Завдання\n\nАктивних завдань немає." : "📋 Задачи\n\nАктивных задач нет.";
  const lines = [uk ? "📋 Завдання" : "📋 Задачи", ""];
  for (const [index, row] of uniqueRows.slice(0, 8).entries()) {
    const icon = importanceIcon(row.task.importance) || (row.task.recurrenceRule ? "🔁" : row.occurrence ? "•" : "🫧");
    const state = row.occurrence?.overdue ? (uk ? " · прострочено" : " · просрочено") : row.occurrence?.status === "in_progress" ? (uk ? " · у роботі" : " · в работе") : "";
    lines.push(`${index + 1}. ${icon} ${row.task.title}${overviewWhen(row.task, row.occurrence, now)}${state}`);
  }
  if (uniqueRows.length > 8) lines.push(uk ? `+ ще ${uniqueRows.length - 8}` : `+ ещё ${uniqueRows.length - 8}`);
  lines.push("", uk ? "Щоб змінити, завершити або перенести завдання, напиши це звичайним повідомленням." : "Чтобы изменить, завершить или перенести задачу, напиши это обычным сообщением.");
  return lines.join("\n");
}

/** Opens the numbered item shown in a compact overview. */
export function taskListKeyboard(rows: TelegramTaskListRow[], locale: TelegramLocale = "ru", options: { showAll?: boolean; allCount?: number; visibleCount?: number; expanded?: boolean } = {}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const visible = rows.slice(0, options.visibleCount ?? 6);
  for (const [index, row] of visible.entries()) {
    const target = row.occurrence ? `view:occ:${row.occurrence.id}` : `view:task:${row.task.id}`;
    const title = row.task.title.length > 30 ? `${row.task.title.slice(0, 29)}…` : row.task.title;
    keyboard.text(`${index + 1}. ${title}`, target).row();
  }
  if (options.showAll && (options.allCount ?? rows.length) > visible.length) keyboard.text(t(locale, "show_all_button", { count: options.allCount ?? rows.length }), "nav:today_all").row();
  if (options.expanded) keyboard.text(t(locale, "collapse_button"), "nav:today").row();
  keyboard.text(t(locale, "today_button"), "nav:today").text(t(locale, "tasks_button"), "nav:tasks");
  return keyboard;
}

/** Each upcoming reminder is a button that cancels it; the footer leads back to the main screens. */
export function remindersKeyboard(rows: ReadonlyArray<{ deliveryId: string; title: string; when: string }>, locale: TelegramLocale = "ru"): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of rows) {
    const title = row.title.length > 24 ? `${row.title.slice(0, 23)}…` : row.title;
    keyboard.text(t(locale, "reminder_cancel_button", { title, when: row.when }), `rem:cancel:${row.deliveryId}`).row();
  }
  keyboard.text(t(locale, "today_button"), "nav:today").text(t(locale, "tasks_button"), "nav:tasks");
  return keyboard;
}

export function screenFooterKeyboard(locale: TelegramLocale = "ru"): InlineKeyboard {
  return new InlineKeyboard().text(t(locale, "today_button"), "nav:today").text(t(locale, "tasks_button"), "nav:tasks");
}

export function taskDetailKeyboard(occurrenceId: string, status: TelegramOccurrenceStatus, locale: TelegramLocale = "ru"): InlineKeyboard {
  return taskKeyboard(occurrenceId, status, locale).row().text(t(locale, "to_tasks_button"), "nav:tasks");
}

export function fuzzyTaskDetailKeyboard(locale: TelegramLocale = "ru"): InlineKeyboard {
  return new InlineKeyboard().text(t(locale, "to_tasks_button"), "nav:tasks").text(t(locale, "today_button"), "nav:today");
}

export function todayText(rows: Array<{ task: TelegramTaskCard; occurrence: TelegramOccurrenceCard | null }>, localDate: string, locale: TelegramLocale = "ru", completedCount = 0, visibleLimit = 6, now: Date = new Date()): string {
  if (locale === "en") {
    if (!rows.length) return "☀️ Today\n\nNothing is planned.";
    const top = rows.slice(0, visibleLimit);
    const main = top.find(({ task }) => task.importance !== "normal") ?? top[0];
    const lines = [`☀️ Today · ${rows.length} ${taskWord(rows.length, locale)}`];
    if (main) lines.push(`\nMain: ${main.task.title}`);
    lines.push("");
    for (const { task, occurrence } of top) lines.push(todayLine(task, occurrence, localDate, locale, now));
    if (rows.length > top.length) lines.push(`+ ${rows.length - top.length} more`);
    if (completedCount) lines.push(`\n✅ Completed today: ${completedCount}`);
    return lines.join("\n");
  }
  const uk = locale === "uk";
  if (!rows.length) return uk ? "☀️ Сьогодні\n\nЗапланованих справ немає." : "☀️ Сегодня\n\nЗапланированных дел нет.";
  const top = rows.slice(0, visibleLimit);
  const main = top.find(({ task }) => task.importance !== "normal") ?? top[0];
  const lines = [`${uk ? "☀️ Сьогодні" : "☀️ Сегодня"} · ${rows.length} ${taskWord(rows.length, locale)}`];
  if (main) lines.push(`\n${uk ? "Головне" : "Главное"}: ${main.task.title}`);
  lines.push("");
  for (const { task, occurrence } of top) lines.push(todayLine(task, occurrence, localDate, locale, now));
  if (rows.length > top.length) lines.push(uk ? `+ ще ${rows.length - top.length}` : `+ ещё ${rows.length - top.length}`);
  if (completedCount) lines.push(`\n✅ ${uk ? "Виконано сьогодні" : "Выполнено сегодня"}: ${completedCount}`);
  return lines.join("\n");
}

export function goalsOverviewText(rows: Array<{
  goal: { title: string; status: "active" | "paused" | "completed" | "cancelled"; why: string | null; targetLocalDate: string | null };
  tasks: Array<{ title: string; nextAction: string | null; context: string | null; dueLocalDate: string | null }>;
}>, locale: TelegramLocale = "ru"): string {
  if (locale === "en") {
    if (!rows.length) return "🎯 Goals\n\nNo goals yet. For example: “I want to prepare for a half marathon.”";
    const lines = ["🎯 Goals", ""];
    const visibleRows = rows.slice(0, 8);
    for (const [index, row] of visibleRows.entries()) {
      const status = row.goal.status === "paused" ? " · paused" : row.goal.status === "completed" ? " · completed" : "";
      const deadline = row.goal.targetLocalDate ? ` · by ${row.goal.targetLocalDate}` : "";
      lines.push(`${index + 1}. ${row.goal.title}${status}${deadline}`);
      if (row.goal.why) lines.push(`   Why: ${row.goal.why}`);
      for (const task of row.tasks.slice(0, 4)) {
        const goalDetails = selectCardDetails(task);
        const detailValue = goalDetails.nextAction ?? goalDetails.context ?? (task.dueLocalDate ? `by ${task.dueLocalDate}` : null);
        lines.push(`   • ${task.title}${detailValue ? ` — ${detailValue}` : ""}`);
      }
      if (!row.tasks.length) lines.push("   • No linked active tasks.");
      if (row.tasks.length > 4) lines.push(`   • ${row.tasks.length - 4} more ${taskWord(row.tasks.length - 4, locale)}`);
      lines.push("");
    }
    if (rows.length > visibleRows.length) lines.push(`${rows.length - visibleRows.length} more goals.`);
    lines.push("To edit a goal or link a task, just write it in a message.");
    return compactText(lines.join("\n"), 3_800);
  }
  const uk = locale === "uk";
  if (!rows.length) return uk ? "🎯 Цілі\n\nЦілей поки немає. Напиши, наприклад: «Хочу підготуватися до напівмарафону»." : "🎯 Цели\n\nЦелей пока нет. Напиши, например: «Хочу подготовиться к полумарафону».";
  const lines = [uk ? "🎯 Цілі" : "🎯 Цели", ""];
  const visibleRows = rows.slice(0, 8);
  for (const [index, row] of visibleRows.entries()) {
    const status = row.goal.status === "paused" ? (uk ? " · на паузі" : " · на паузе") : row.goal.status === "completed" ? (uk ? " · завершена" : " · завершена") : "";
    const deadline = row.goal.targetLocalDate ? ` · ${uk ? "до" : "до"} ${row.goal.targetLocalDate}` : "";
    lines.push(`${index + 1}. ${row.goal.title}${status}${deadline}`);
    if (row.goal.why) lines.push(`   ${uk ? "Навіщо" : "Зачем"}: ${row.goal.why}`);
    if (row.tasks.length) {
      for (const task of row.tasks.slice(0, 4)) {
        const goalDetails = selectCardDetails(task);
        const detailValue = goalDetails.nextAction ?? goalDetails.context ?? (task.dueLocalDate ? `до ${task.dueLocalDate}` : null);
        const detail = detailValue ? ` — ${detailValue}` : "";
        lines.push(`   • ${task.title}${detail}`);
      }
      if (row.tasks.length > 4) lines.push(`   • ${uk ? "ще" : "ещё"} ${row.tasks.length - 4} ${taskWord(row.tasks.length - 4, locale)}`);
    } else {
      lines.push(uk ? "   • Пов'язаних активних завдань немає." : "   • Связанных активных задач нет.");
    }
    lines.push("");
  }
  if (rows.length > visibleRows.length) lines.push(uk ? `Ще цілей: ${rows.length - visibleRows.length}.` : `Ещё целей: ${rows.length - visibleRows.length}.`);
  lines.push(uk ? "Щоб змінити ціль або пов'язати завдання, напиши це звичайним повідомленням." : "Чтобы изменить цель или связать задачу, напиши это обычным сообщением.");
  return compactText(lines.join("\n"), 3_800);
}

export function todayLine(task: TelegramTaskCard, occurrence: TelegramOccurrenceCard | null, localDate: string, locale: TelegramLocale, now: Date = new Date()): string {
  const icon = importanceIcon(task.importance) || (task.recurrenceRule ? "🔁" : "•");
  if (!occurrence) {
    const fuzzyIcon = importanceIcon(task.importance) || "🫧";
    const review = task.reviewAt
      ? ` · ${locale === "en" ? "review at" : locale === "uk" ? "переглянути о" : "пересмотреть в"} ${formatTime(new Date(task.reviewAt), task.timezone)}`
      : "";
    return `${fuzzyIcon} ${task.title}${review}`;
  }
  const tz = occurrence.timezone;
  const sameDay = (value: Date | string | null | undefined) => Boolean(value) && localDateAt(new Date(value!), tz) === localDate;
  let when = "";
  if (occurrence.plannedStartAt && occurrence.plannedEndAt && sameDay(occurrence.plannedStartAt)) when = `${formatTime(new Date(occurrence.plannedStartAt), tz)}–${formatTime(new Date(occurrence.plannedEndAt), tz)}`;
  else if (occurrence.plannedStartAt && sameDay(occurrence.plannedStartAt)) when = formatTime(new Date(occurrence.plannedStartAt), tz);
  else if (occurrence.dueAt && sameDay(occurrence.dueAt)) when = `${locale === "en" ? "by" : "до"} ${formatTime(new Date(occurrence.dueAt), tz)}`;
  else if (occurrence.plannedStartAt || occurrence.dueAt) when = formatLocalDateTime(new Date((occurrence.plannedStartAt ?? occurrence.dueAt)!), tz, now);
  else if (occurrence.dueLocalDate && occurrence.dueLocalDate !== localDate) when = `${locale === "en" ? "by" : "до"} ${formatDateLabel(occurrence.dueLocalDate, tz, now)}`;
  const state = occurrence.overdue ? (locale === "en" ? "overdue" : locale === "uk" ? "прострочено" : "просрочено")
    : occurrence.status === "in_progress" ? (locale === "en" ? "in progress" : locale === "uk" ? "у роботі" : "в работе") : "";
  const parts = [when, state].filter(Boolean);
  return `${icon} ${task.title}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

/** Compact "when" for list screens: exact time, deadline, date or fuzzy horizon. */
function overviewWhen(task: TelegramTaskCard, occurrence: TelegramOccurrenceCard | null, now: Date): string {
  if (!occurrence) return task.fuzzyHorizonText ? ` · 🫧 ${task.fuzzyHorizonText}` : "";
  const when = occurrenceWhen(occurrence, now);
  return when ? ` · ${when}` : "";
}

function relativeDue(occurrence: TelegramOccurrenceCard, now: Date): string {
  const target = occurrence.dueAt ? new Date(occurrence.dueAt) : occurrence.plannedStartAt ? new Date(occurrence.plannedStartAt) : null;
  if (!target) return occurrence.overdue ? "⚠️ просрочено" : "";
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (minutes < -1) return `⚠️ просрочено${overdueFor(occurrence, now)}`;
  if (minutes <= 1) return "сейчас";
  if (minutes < 60) return `через ${minutes} мин`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest && hours < 6 ? `через ${hours} ч ${rest} мин` : `через ${Math.round(minutes / 60)} ч`;
  }
  return `через ${Math.round(minutes / (24 * 60))} дн`;
}

function importanceIcon(importance: TelegramImportance): string {
  return importance === "critical" ? "🔴" : importance === "required" ? "🟡" : "";
}

function formatLocal(at: Date, timezone: string): string {
  return formatLocalDateTime(at, timezone, new Date());
}

function formatTime(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(at);
}

function formatDateLabel(value: string, timezone?: string, now?: Date): string {
  const [year, month, day] = value.split("-");
  if (!(day && month && year)) return value;
  const currentYear = now && timezone ? localDateAt(now, timezone).slice(0, 4) : year;
  return currentYear === year ? `${day}.${month}` : `${day}.${month}.${year}`;
}

function taskWord(count: number, locale: TelegramLocale = "ru"): string {
  if (locale === "en") return count === 1 ? "task" : "tasks";
  if (locale === "uk") return count === 1 ? "справа" : count >= 2 && count <= 4 ? "справи" : "справ";
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return "дел";
  if (mod10 === 1) return "дело";
  if (mod10 >= 2 && mod10 <= 4) return "дела";
  return "дел";
}

function messageWord(count: number, locale: TelegramLocale = "ru"): string {
  if (locale === "en") return count === 1 ? "message" : "messages";
  if (locale === "uk") return count === 1 ? "повідомлення" : count >= 2 && count <= 4 ? "повідомлення" : "повідомлень";
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return "сообщений";
  if (mod10 === 1) return "сообщение";
  if (mod10 >= 2 && mod10 <= 4) return "сообщения";
  return "сообщений";
}

function quietHoursLabel(row: { quietHoursEnabled: boolean; weekdayQuietStart: string; weekdayQuietEnd: string; weekendQuietStart?: string | null; weekendQuietEnd?: string | null }, locale: TelegramLocale): string {
  if (!row.quietHoursEnabled) return locale === "en" ? "off" : locale === "uk" ? "вимкнено" : "выкл";
  const weekday = `${row.weekdayQuietStart}–${row.weekdayQuietEnd}`;
  const weekend = row.weekendQuietStart && row.weekendQuietEnd ? `${row.weekendQuietStart}–${row.weekendQuietEnd}` : null;
  if (!weekend || weekend === weekday) return weekday;
  return locale === "en" ? `${weekday} (weekdays), ${weekend} (weekends)` : locale === "uk" ? `${weekday} (будні), ${weekend} (вихідні)` : `${weekday} (будни), ${weekend} (выходные)`;
}

function weekdayLabel(value: number, locale: TelegramLocale): string {
  const labels = locale === "en"
    ? ["?", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    : locale === "uk"
    ? ["?", "пн", "вт", "ср", "чт", "пт", "сб", "нд"]
    : ["?", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
  return labels[value] ?? String(value);
}

/** Which code is answering: the deploy pipeline checks out one exact commit, so its short SHA identifies the build. */
export function deployedBuildLine(commit: string | undefined, locale: TelegramLocale): string {
  const label = commit ? commit.slice(0, 7) : null;
  if (locale === "uk") return label ? `🏷 Збірка: ${label}` : "🏷 Збірка: невідома (APP_COMMIT не заданий)";
  if (locale === "en") return label ? `🏷 Build: ${label}` : "🏷 Build: unknown (APP_COMMIT is not set)";
  return label ? `🏷 Сборка: ${label}` : "🏷 Сборка: неизвестна (APP_COMMIT не задан)";
}
