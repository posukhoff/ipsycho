import { InlineKeyboard } from "grammy";
import { t } from "./copy/index.js";
import type { TelegramLocale } from "./telegram-locale.js";
import { appendLaunchButton, webAppLink } from "./telegram-webapp.js";

/**
 * Every inline keyboard the bot still builds. Each payload must match a handler pattern and fit
 * 64 bytes.
 *
 * After task 11 that is a short list: the reaction cards. A button lives in chat only if it answers
 * the message it is attached to, in the moment that message arrives (design.md § 1) — so the task
 * card, the three quick moves, the reschedule reason and the week card's goal steps are here, and
 * every list, filter, page and detail screen is a route in the Mini App instead.
 */
export interface TaskKeyboardOptions {
  /** A reminder card offers to be repeated later without touching the task's own time. */
  snooze?: boolean;
  /** A critical escalation offers to stop repeating for this occurrence. */
  mute?: boolean;
  /** Whether this occurrence belongs to a series; only a repeat can be skipped. */
  recurring?: boolean;
  /**
   * The Mini App origin, or `null`/absent when `WEBAPP_ENABLED` is off. With it the card ends in a
   * launch button into that occurrence's screen; without it the card is the same buttons minus that
   * one. Cancelling, pausing a series and picking an arbitrary date used to hide behind «⚙️ Ещё»;
   * they are sheets in the app now, and the flag being off does not bring them back to chat.
   */
  webAppUrl?: string | null;
}

export function taskKeyboard(occurrenceId: string, locale: TelegramLocale = "ru", options: TaskKeyboardOptions = {}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const launch = webAppLink(options.webAppUrl, { name: "task", id: occurrenceId });
  keyboard.text(label(locale, "done"), `occ:done:${occurrenceId}`).row();
  if (options.snooze)
    keyboard.text(t(locale, "snooze_15m_button"), `follow:snooze:15m:${occurrenceId}`).text(t(locale, "snooze_1h_button"), `follow:snooze:1h:${occurrenceId}`).row();
  if (options.recurring) keyboard.text(label(locale, "skip"), `occ:skip:${occurrenceId}`).row();
  keyboard.text(label(locale, "later"), `occ:resched:${occurrenceId}`);
  if (launch) keyboard.webApp(t(locale, "webapp_open_task_button"), launch);
  if (options.mute) keyboard.row().text(t(locale, "mute_escalation_button"), `rem:mute:${occurrenceId}`);
  return keyboard;
}

/**
 * The three quick moves stay in chat: they answer the reminder that just arrived. Picking an
 * arbitrary date is browsing — it used to arm a free-text prompt behind «📅 Другая дата» — so it is
 * the occurrence's sheet in the app now, and the row is simply absent when the app is off.
 */
export function quickRescheduleKeyboard(occurrenceId: string, locale: TelegramLocale = "ru", webAppUrl?: string | null): InlineKeyboard {
  const launch = webAppLink(webAppUrl, { name: "task", id: occurrenceId });
  const keyboard = new InlineKeyboard()
    .text(label(locale, "plusHour"), `resched:1h:${occurrenceId}`)
    .text(label(locale, "evening"), `resched:evening:${occurrenceId}`)
    .row()
    .text(label(locale, "tomorrow"), `resched:tomorrow:${occurrenceId}`);
  if (launch) keyboard.webApp(t(locale, "webapp_open_task_button"), launch);
  return keyboard.row().text(t(locale, "back_button"), `occ:back:${occurrenceId}`);
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

const BUTTON_LABELS = {
  ru: {
    done: "✅ Готово",
    later: "🕒 Позже",
    skip: "⏭ Пропустить это",
    plusHour: "+1 час",
    evening: "Вечером",
    tomorrow: "Завтра",
    other: "Другое",
    reasonTime: "Не успеваю",
    reasonDependency: "Зависит от другого",
    reasonEnergy: "Нет сил",
  },
  uk: {
    done: "✅ Готово",
    later: "🕒 Пізніше",
    skip: "⏭ Пропустити це",
    plusHour: "+1 година",
    evening: "Увечері",
    tomorrow: "Завтра",
    other: "Інше",
    reasonTime: "Не встигаю",
    reasonDependency: "Залежить від іншого",
    reasonEnergy: "Немає сил",
  },
  en: {
    done: "✅ Done",
    later: "🕒 Later",
    skip: "⏭ Skip this one",
    plusHour: "+1 hour",
    evening: "This evening",
    tomorrow: "Tomorrow",
    other: "Other",
    reasonTime: "Out of time",
    reasonDependency: "Depends on something",
    reasonEnergy: "No energy",
  },
} as const;

function label(locale: TelegramLocale, key: keyof (typeof BUTTON_LABELS)["ru"]): string {
  return BUTTON_LABELS[locale][key];
}

/**
 * The week card's buttons: one row per goal nothing has moved, then the way into the week plan.
 *
 * The goal row is the only place the bot proposes work of its own, and it asks the model only when
 * tapped — a conversation turn with a shortcut, which is why it stayed in chat while the pool it
 * used to link to became a screen.
 */
export function weeklyBriefingKeyboard(idleGoals: ReadonlyArray<{ id: string; title: string }>, locale: TelegramLocale = "ru", webAppUrl?: string | null): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const goal of idleGoals.slice(0, 3)) {
    keyboard.text(t(locale, "goal_step_button", { title: goal.title.length > 24 ? `${goal.title.slice(0, 23)}…` : goal.title }), `goal:step:${goal.id}`).row();
  }
  return appendLaunchButton(keyboard, webAppUrl, { name: "week" }, locale);
}
