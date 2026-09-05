import { InlineKeyboard } from "grammy";
import { t } from "./copy/index.js";
import type { TelegramLocale } from "./telegram-locale.js";
import type { TaskScope } from "../core/task-list-view.js";
import type { TelegramGroupCard } from "./telegram-format.js";

/** Every inline keyboard the bot builds. Each payload must match a handler pattern and fit 64 bytes. */
export interface TaskKeyboardOptions {
  /** A reminder card offers to be repeated later without touching the task's own time. */
  snooze?: boolean;
  /** A critical escalation offers to stop repeating for this occurrence. */
  mute?: boolean;
}

export function taskKeyboard(occurrenceId: string, locale: TelegramLocale = "ru", options: TaskKeyboardOptions = {}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text(label(locale, "done"), `occ:done:${occurrenceId}`).row();
  if (options.snooze)
    keyboard.text(t(locale, "snooze_15m_button"), `follow:snooze:15m:${occurrenceId}`).text(t(locale, "snooze_1h_button"), `follow:snooze:1h:${occurrenceId}`).row();
  keyboard.text(label(locale, "later"), `occ:resched:${occurrenceId}`).text(label(locale, "more"), `occ:more:${occurrenceId}`);
  if (options.mute) keyboard.row().text(t(locale, "mute_escalation_button"), `rem:mute:${occurrenceId}`);
  return keyboard;
}

/** The destructive actions live one tap deeper, behind an explicit label rather than "•••". */
export function taskMoreKeyboard(occurrenceId: string, recurring = false, taskId?: string, locale: TelegramLocale = "ru", endless = false): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (recurring) keyboard.text(label(locale, "skip"), `occ:skip:${occurrenceId}`).row();
  // Pausing a series that already has an end date only loses dates: it is offered for endless repeats.
  if (recurring && endless && taskId) keyboard.text(label(locale, "pauseSeries"), `series:pause:${taskId}`).row();
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

const BUTTON_LABELS = {
  ru: {
    done: "✅ Готово",
    later: "🕒 Позже",
    more: "⚙️ Ещё",
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
  },
  uk: {
    done: "✅ Готово",
    later: "🕒 Пізніше",
    more: "⚙️ Ще",
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
  },
  en: {
    done: "✅ Done",
    later: "🕒 Later",
    more: "⚙️ More",
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
  },
} as const;

function label(locale: TelegramLocale, key: keyof (typeof BUTTON_LABELS)["ru"]): string {
  return BUTTON_LABELS[locale][key];
}

/** Every toggle the settings card shows is one tap; free text remains for values (times, days). */
export function settingsKeyboard(locale: TelegramLocale = "ru", row?: { morningDigestEnabled: boolean; weeklyReviewEnabled: boolean; quietHoursEnabled: boolean }): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (row) {
    keyboard
      .text(t(locale, row.morningDigestEnabled ? "prefs_morning_on" : "prefs_morning_off"), "prefs:morning:toggle")
      .text(t(locale, row.weeklyReviewEnabled ? "prefs_weekly_on" : "prefs_weekly_off"), "prefs:weekly:toggle")
      .row()
      .text(t(locale, row.quietHoursEnabled ? "prefs_quiet_on" : "prefs_quiet_off"), "prefs:quiet:toggle")
      .row();
  }
  keyboard
    .text(t(locale, "settings_timezone_button"), "prefs:tz:open")
    .text(t(locale, "settings_language_button"), "prefs:lang:open")
    .row()
    .text(t(locale, "prefs_snooze_morning"), "prefs:snooze:morning")
    .text(t(locale, "week_plan_button"), "nav:week")
    .row()
    .text(t(locale, "prefs_context"), "profile:open")
    .text(t(locale, "prefs_clear_history"), "history:clear")
    .row();
  return appendFooter(keyboard, locale);
}

/**
 * Opens the numbered item shown in a compact overview. A group of one goes straight to its card;
 * a group of several opens the group first, because "Done" on a line that stands for three dates
 * would not say which one it closed.
 */
export function taskListKeyboard(
  groups: ReadonlyArray<TelegramGroupCard>,
  locale: TelegramLocale = "ru",
  options: { source: GroupSource; offset?: number; pageCallback?: (page: number) => string; page?: number; pages?: number; rest?: number } = { source: "tasks" },
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const offset = options.offset ?? 0;
  for (const [index, group] of groups.entries()) {
    const target = groupCallback(group, options.source);
    const title = group.title.length > 30 ? `${group.title.slice(0, 29)}…` : group.title;
    keyboard.text(`${offset + index + 1}. ${title}`, target).row();
  }
  const page = options.page ?? 0;
  const pages = options.pages ?? 1;
  if (options.pageCallback && pages > 1) {
    if (page > 0) keyboard.text(t(locale, "page_prev_button"), options.pageCallback(page - 1));
    if (page < pages - 1) keyboard.text(t(locale, "page_next_button", { count: options.rest ?? 0 }), options.pageCallback(page + 1));
    keyboard.row();
  }
  return keyboard;
}

export type GroupSource = "tasks" | "today";

/** Where a collapsed line leads: one occurrence, one fuzzy task, or the group's own screen. */
export function groupCallback(group: TelegramGroupCard, source: GroupSource): string {
  if (group.rows.length > 1) return `grp:${source === "today" ? "d" : "t"}:${group.key}`;
  return group.lead.occurrence ? `view:occ:${group.lead.occurrence.id}` : `view:task:${group.lead.task.id}`;
}

/** The date window the list is showing, and every other window one tap away. */
export function taskScopeKeyboard(scope: TaskScope, counts: Record<TaskScope, number>, locale: TelegramLocale = "ru", pausedCount = 0): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (counts.overdue) keyboard.text(mark(scope === "overdue", t(locale, "scope_overdue_button", { count: counts.overdue })), "tsk:overdue:0");
  keyboard
    .text(mark(scope === "today", t(locale, "scope_today_button")), "tsk:today:0")
    .text(mark(scope === "week", t(locale, "scope_week_button")), "tsk:week:0")
    .row()
    .text(mark(scope === "month", t(locale, "scope_month_button")), "tsk:month:0")
    .text(mark(scope === "all", t(locale, "scope_all_button")), "tsk:all:0");
  if (counts.nodate) keyboard.text(mark(scope === "nodate", t(locale, "scope_nodate_button")), "tsk:nodate:0");
  keyboard.row();
  // A paused series is in no window: its parent row is not active and its future dates are gone.
  if (pausedCount) keyboard.text(t(locale, "paused_series_button", { count: pausedCount }), "paused:0").row();
  return keyboard;
}

/** The week plan: one toggle per pool task, and paging. The tap itself is the reversal. */
export function weekPlanKeyboard(
  rows: ReadonlyArray<{ id: string; title: string; picked: boolean }>,
  locale: TelegramLocale = "ru",
  paging: { page?: number; pages?: number; rest?: number } = {},
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of rows) {
    const title = row.title.length > 26 ? `${row.title.slice(0, 25)}\u2026` : row.title;
    keyboard.text(`${row.picked ? "☑️" : "◻️"} ${title}`, `wk:t:${paging.page ?? 0}:${row.id}`).row();
  }
  const page = paging.page ?? 0;
  const pages = paging.pages ?? 1;
  if (pages > 1) {
    if (page > 0) keyboard.text(t(locale, "page_prev_button"), `wk:p:${page - 1}`);
    if (page < pages - 1) keyboard.text(t(locale, "page_next_button", { count: paging.rest ?? 0 }), `wk:p:${page + 1}`);
    keyboard.row();
  }
  return appendFooter(keyboard, locale);
}

/** The morning card's take-today rows: one tap gives that task today. */
export function weekTakeTodayKeyboard(rows: ReadonlyArray<{ id: string; title: string }>, locale: TelegramLocale = "ru"): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of rows.slice(0, 8)) {
    const title = row.title.length > 24 ? `${row.title.slice(0, 23)}\u2026` : row.title;
    keyboard.text(t(locale, "week_take_today_row", { title }), `wk:d:${row.id}`).row();
  }
  return keyboard.text(t(locale, "today_button"), "nav:today");
}

/** Paused series, one row each: the tap that brings the series back. */
export function pausedSeriesKeyboard(
  rows: ReadonlyArray<{ id: string; title: string }>,
  locale: TelegramLocale = "ru",
  paging: { page?: number; pages?: number; rest?: number } = {},
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of rows) {
    const title = row.title.length > 24 ? `${row.title.slice(0, 23)}\u2026` : row.title;
    keyboard.text(t(locale, "resume_series_button", { title }), `series:resume:${row.id}`).row();
  }
  const page = paging.page ?? 0;
  const pages = paging.pages ?? 1;
  if (pages > 1) {
    if (page > 0) keyboard.text(t(locale, "page_prev_button"), `paused:${page - 1}`);
    if (page < pages - 1) keyboard.text(t(locale, "page_next_button", { count: paging.rest ?? 0 }), `paused:${page + 1}`);
    keyboard.row();
  }
  keyboard.text(t(locale, "back_button"), "nav:tasks").row();
  return appendFooter(keyboard, locale);
}

function mark(active: boolean, label: string): string {
  return active ? `• ${label}` : label;
}

/** Every screen ends with the same five destinations, so no screen is a dead end. */
export function appendFooter(keyboard: InlineKeyboard, locale: TelegramLocale): InlineKeyboard {
  return keyboard
    .text(t(locale, "today_button"), "nav:today")
    .text(t(locale, "tasks_button"), "nav:tasks")
    .row()
    .text(t(locale, "goals_button"), "nav:goals")
    .text(t(locale, "reminders_button"), "nav:reminders")
    .text(t(locale, "settings_button"), "nav:settings");
}

/** Each upcoming reminder is a button that cancels it; the footer leads back to the main screens. */

/** Each upcoming reminder is a button that cancels it; the footer leads back to the main screens. */
export function remindersKeyboard(
  rows: ReadonlyArray<{ deliveryId: string; title: string; when: string }>,
  locale: TelegramLocale = "ru",
  paging: { page?: number; pages?: number; rest?: number } = {},
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of rows) {
    const title = row.title.length > 24 ? `${row.title.slice(0, 23)}…` : row.title;
    keyboard.text(t(locale, "reminder_cancel_button", { title, when: row.when }), `rem:cancel:${row.deliveryId}`).row();
  }
  const page = paging.page ?? 0;
  const pages = paging.pages ?? 1;
  if (pages > 1) {
    if (page > 0) keyboard.text(t(locale, "page_prev_button"), `rem:p:${page - 1}`);
    if (page < pages - 1) keyboard.text(t(locale, "page_next_button", { count: paging.rest ?? 0 }), `rem:p:${page + 1}`);
    keyboard.row();
  }
  return appendFooter(keyboard, locale);
}

/** Which slice of the goal list is on screen; the rest is one tap away. */
export function goalsScopeKeyboard(scope: GoalScope, locale: TelegramLocale = "ru"): InlineKeyboard {
  return new InlineKeyboard()
    .text(mark(scope === "active", t(locale, "goals_scope_active_button")), "gl:active:0")
    .text(mark(scope === "paused", t(locale, "goals_scope_paused_button")), "gl:paused:0")
    .text(mark(scope === "completed", t(locale, "goals_scope_completed_button")), "gl:completed:0")
    .row();
}

export type GoalScope = "active" | "paused" | "completed";

/** Each goal opens its own screen instead of printing its tasks into the list. */
export function goalListKeyboard(
  goals: ReadonlyArray<{ id: string; title: string }>,
  locale: TelegramLocale = "ru",
  paging: { offset?: number; page?: number; pages?: number; rest?: number; scope?: GoalScope } = {},
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const offset = paging.offset ?? 0;
  for (const [index, goal] of goals.entries()) {
    const title = goal.title.length > 30 ? `${goal.title.slice(0, 29)}…` : goal.title;
    keyboard.text(`${offset + index + 1}. ${title}`, `goal:${goal.id}`).row();
  }
  const page = paging.page ?? 0;
  const pages = paging.pages ?? 1;
  if (pages > 1) {
    const scope = paging.scope ?? "active";
    if (page > 0) keyboard.text(t(locale, "page_prev_button"), `gl:${scope}:${page - 1}`);
    if (page < pages - 1) keyboard.text(t(locale, "page_next_button", { count: paging.rest ?? 0 }), `gl:${scope}:${page + 1}`);
    keyboard.row();
  }
  return keyboard;
}

export function goalDetailKeyboard(tasks: ReadonlyArray<{ id: string; title: string }>, locale: TelegramLocale = "ru"): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const task of tasks.slice(0, 8)) {
    const title = task.title.length > 30 ? `${task.title.slice(0, 29)}…` : task.title;
    keyboard.text(title, `view:task:${task.id}`).row();
  }
  keyboard.text(t(locale, "back_button"), "gl:active:0").row();
  return appendFooter(keyboard, locale);
}

export function screenFooterKeyboard(locale: TelegramLocale = "ru"): InlineKeyboard {
  return appendFooter(new InlineKeyboard(), locale);
}

export function taskDetailKeyboard(occurrenceId: string, locale: TelegramLocale = "ru"): InlineKeyboard {
  return taskKeyboard(occurrenceId, locale).row().text(t(locale, "to_tasks_button"), "nav:tasks");
}

/** The three languages plus "follow Telegram", so the value is a tap and not a command. */
export function languageKeyboard(locale: TelegramLocale = "ru"): InlineKeyboard {
  return new InlineKeyboard()
    .text("Русский", "prefs:lang:ru")
    .text("Українська", "prefs:lang:uk")
    .text("English", "prefs:lang:en")
    .row()
    .text(t(locale, "settings_language_auto_button"), "prefs:lang:auto")
    .row()
    .text(t(locale, "back_button"), "nav:settings");
}

export function fuzzyTaskDetailKeyboard(locale: TelegramLocale = "ru"): InlineKeyboard {
  return new InlineKeyboard().text(t(locale, "to_tasks_button"), "nav:tasks").text(t(locale, "today_button"), "nav:today");
}

/** One expanded group: every row of it opens its own card, and the list it came from stays one tap away. */
export function taskGroupKeyboard(group: TelegramGroupCard, source: GroupSource, locale: TelegramLocale = "ru"): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, row] of group.rows.entries()) {
    const target = row.occurrence ? `view:occ:${row.occurrence.id}` : `view:task:${row.task.id}`;
    keyboard.text(`${index + 1}. ${row.task.title.length > 26 ? `${row.task.title.slice(0, 25)}…` : row.task.title}`, target).row();
  }
  const endlessSeriesTaskId = group.recurrenceRule && !group.lead.task.recurrenceEndLocalDate ? group.lead.task.id : null;
  if (endlessSeriesTaskId) keyboard.text(label(locale, "pauseSeries"), `series:pause:${endlessSeriesTaskId}`).row();
  keyboard.text(t(locale, "back_button"), source === "today" ? "tdy:0" : "tsk:week:0").row();
  return appendFooter(keyboard, locale);
}
