import { InlineKeyboard } from "grammy";
import { t } from "./copy/index.js";
import type { TelegramLocale } from "./telegram-locale.js";
import type { TelegramOccurrenceStatus, TelegramTaskListRow } from "./telegram-format.js";

/** Every inline keyboard the bot builds. Each payload must match a handler pattern and fit 64 bytes. */
export interface TaskKeyboardOptions {
  /** A reminder card offers to be repeated later without touching the task's own time. */
  snooze?: boolean;
  /** A critical escalation offers to stop repeating for this occurrence. */
  mute?: boolean;
}

export function taskKeyboard(occurrenceId: string, status: TelegramOccurrenceStatus, locale: TelegramLocale = "ru", options: TaskKeyboardOptions = {}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (status === "in_progress") return startedTaskKeyboard(occurrenceId, locale, options);
  keyboard.text(label(locale, "start"), `occ:start:${occurrenceId}`).text(label(locale, "done"), `occ:done:${occurrenceId}`).row();
  if (options.snooze) keyboard.text(t(locale, "snooze_15m_button"), `follow:seen:15m:${occurrenceId}`).text(t(locale, "snooze_1h_button"), `follow:seen:1h:${occurrenceId}`).row();
  keyboard.text(label(locale, "later"), `occ:resched:${occurrenceId}`).text(label(locale, "more"), `occ:more:${occurrenceId}`);
  if (options.mute) keyboard.row().text(t(locale, "mute_escalation_button"), `rem:mute:${occurrenceId}`);
  return keyboard;
}

export function startedTaskKeyboard(occurrenceId: string, locale: TelegramLocale = "ru", options: TaskKeyboardOptions = {}): InlineKeyboard {
  const keyboard = new InlineKeyboard().text(label(locale, "done"), `occ:done:${occurrenceId}`).text(label(locale, "later"), `occ:resched:${occurrenceId}`).row();
  if (options.snooze) keyboard.text(t(locale, "snooze_15m_button"), `follow:seen:15m:${occurrenceId}`).text(t(locale, "snooze_1h_button"), `follow:seen:1h:${occurrenceId}`).row();
  keyboard.text(label(locale, "stuck"), `occ:cant:${occurrenceId}`).text(label(locale, "more"), `occ:more:${occurrenceId}`);
  if (options.mute) keyboard.row().text(t(locale, "mute_escalation_button"), `rem:mute:${occurrenceId}`);
  return keyboard;
}

/** The destructive actions live one tap deeper, behind an explicit label rather than "•••". */

/** The destructive actions live one tap deeper, behind an explicit label rather than "•••". */
export function taskMoreKeyboard(occurrenceId: string, status: TelegramOccurrenceStatus, recurring = false, taskId?: string, locale: TelegramLocale = "ru"): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (status === "in_progress") keyboard.text(label(locale, "check"), `occ:check:${occurrenceId}`).row();
  if (recurring) keyboard.text(label(locale, "skip"), `occ:skip:${occurrenceId}`).row();
  if (recurring && taskId) keyboard.text(label(locale, "pauseSeries"), `series:pause:${taskId}`).row();
  if (status !== "in_progress") keyboard.text(label(locale, "stuck"), `occ:cant:${occurrenceId}`).row();
  return keyboard.text(label(locale, "cancel"), `occ:cancel:${occurrenceId}`).row().text(t(locale, "back_button"), `occ:back:${occurrenceId}`);
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
  ru: {
    start: "▶️ Начать",
    done: "✅ Готово",
    later: "🕒 Позже",
    more: "⚙️ Ещё",
    stuck: "🧱 Застрял",
    check: "🔔 Проверить",
    skip: "⏭ Пропустить это",
    pauseSeries: "⏸ Поставить серию на паузу",
    cancel: "❌ Отменить задачу",
    plusHour: "+1 час",
    evening: "Вечером",
    tomorrow: "Завтра",
    otherDate: "📅 Другая дата",
    other: "Другое",
    reasonTime: "Не успеваю",
    reasonDependency: "Зависит от другого",
    reasonEnergy: "Нет сил",
    in15: "Через 15 мин",
    in1h: "Через 1 час",
    noCheck: "Без проверки",
  },
  uk: {
    start: "▶️ Почати",
    done: "✅ Готово",
    later: "🕒 Пізніше",
    more: "⚙️ Ще",
    stuck: "🧱 Застряг",
    check: "🔔 Перевірити",
    skip: "⏭ Пропустити це",
    pauseSeries: "⏸ Поставити серію на паузу",
    cancel: "❌ Скасувати завдання",
    plusHour: "+1 година",
    evening: "Увечері",
    tomorrow: "Завтра",
    otherDate: "📅 Інша дата",
    other: "Інше",
    reasonTime: "Не встигаю",
    reasonDependency: "Залежить від іншого",
    reasonEnergy: "Немає сил",
    in15: "Через 15 хв",
    in1h: "Через 1 годину",
    noCheck: "Без перевірки",
  },
  en: {
    start: "▶️ Start",
    done: "✅ Done",
    later: "🕒 Later",
    more: "⚙️ More",
    stuck: "🧱 Stuck",
    check: "🔔 Check",
    skip: "⏭ Skip this one",
    pauseSeries: "⏸ Pause the series",
    cancel: "❌ Cancel the task",
    plusHour: "+1 hour",
    evening: "This evening",
    tomorrow: "Tomorrow",
    otherDate: "📅 Another date",
    other: "Other",
    reasonTime: "Out of time",
    reasonDependency: "Depends on something",
    reasonEnergy: "No energy",
    in15: "In 15 min",
    in1h: "In 1 hour",
    noCheck: "No check",
  },
} as const;

function label(locale: TelegramLocale, key: keyof (typeof BUTTON_LABELS)["ru"]): string {
  return BUTTON_LABELS[locale][key];
}

/** Every toggle the settings card shows is one tap; free text remains for values (times, days). */
export function settingsKeyboard(
  locale: TelegramLocale = "ru",
  row?: { morningDigestEnabled: boolean; eveningDigestEnabled: boolean; weeklyReviewEnabled: boolean; quietHoursEnabled: boolean },
): InlineKeyboard {
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

/** Opens the numbered item shown in a compact overview. */
export function taskListKeyboard(
  rows: TelegramTaskListRow[],
  locale: TelegramLocale = "ru",
  options: { showAll?: boolean; allCount?: number; visibleCount?: number; expanded?: boolean } = {},
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const visible = rows.slice(0, options.visibleCount ?? 6);
  for (const [index, row] of visible.entries()) {
    const target = row.occurrence ? `view:occ:${row.occurrence.id}` : `view:task:${row.task.id}`;
    const title = row.task.title.length > 30 ? `${row.task.title.slice(0, 29)}…` : row.task.title;
    keyboard.text(`${index + 1}. ${title}`, target).row();
  }
  if (options.showAll && (options.allCount ?? rows.length) > visible.length)
    keyboard.text(t(locale, "show_all_button", { count: options.allCount ?? rows.length }), "nav:today_all").row();
  if (options.expanded) keyboard.text(t(locale, "collapse_button"), "nav:today").row();
  keyboard.text(t(locale, "today_button"), "nav:today").text(t(locale, "tasks_button"), "nav:tasks");
  return keyboard;
}

/** Each upcoming reminder is a button that cancels it; the footer leads back to the main screens. */

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
