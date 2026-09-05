import { compactText } from "../core/telegram-ux.js";
import { recurrenceLabel } from "../core/recurrence-label.js";
import { targetWeekStart, isPickLive, isPickStale } from "../core/week-plan.js";
import { localDateAt, parseLocalDate, shiftLocalDate } from "../core/timezone.js";
import { selectCardDetails } from "../core/card-details.js";
import type { TaskScope } from "../core/task-list-view.js";
import { plural, t, type CopyKey } from "./copy/index.js";
import type { TelegramLocale } from "./telegram-locale.js";
import type { GoalScope } from "./telegram-keyboards.js";
import { todayLine } from "./telegram-cards.js";
import {
  cardCopy,
  formatDateLabel,
  formatLocal,
  formatTime,
  groupWhenLabel,
  importanceIcon,
  messageWord,
  occurrenceWhen,
  quietHoursLabel,
  taskWord,
  weekdayLabel,
  type TelegramGroupCard,
  type TelegramTaskListRow,
} from "./telegram-format.js";

/** The full-screen views: settings, the task list, today and goals. */
export interface SettingsRow {
  timezone: string;
  morningDigestEnabled: boolean;
  morningReferenceTime: string;
  eveningReferenceTime: string;
  weeklyReviewEnabled: boolean;
  weeklyReviewWeekday: number;
  weeklyReviewTime: string;
  digestTimezone?: string | null;
  quietHoursTimezone?: string | null;
  quietHoursEnabled: boolean;
  weekdayQuietStart: string;
  weekdayQuietEnd: string;
  weekendQuietStart?: string | null;
  weekendQuietEnd?: string | null;
  pinnedLanguage?: string | null;
  notificationsSnoozedUntil?: Date | null;
}

/** Grouped into what the setting is about, so eight flat lines do not have to be read in order. */
export function settingsText(row: SettingsRow, now = new Date(), historyMessageCount = 0, locale: TelegramLocale = "ru"): string {
  const words = SETTINGS_COPY[locale];
  // The digests and the quiet window keep their own timezone, and until it is confirmed it is the
  // Kyiv default. Naming it only when it differs keeps the silent assumption out of the product.
  const zone = (value: string | null | undefined) => (value && value !== row.timezone ? ` · ${value}` : "");
  const snoozed =
    row.notificationsSnoozedUntil && row.notificationsSnoozedUntil > now ? `\n🔕 ${words.quietUntil} ${formatLocal(row.notificationsSnoozedUntil, row.timezone)}` : "";
  return [
    words.title,
    "",
    t(locale, "settings_section_time"),
    `🌍 ${words.timezone}: ${row.timezone}${snoozed}`,
    `🗣 ${words.language}: ${row.pinnedLanguage ?? words.languageAuto}`,
    "",
    t(locale, "settings_section_digests"),
    `☀️ ${words.morning}: ${row.morningDigestEnabled ? `${row.morningReferenceTime}${zone(row.digestTimezone)}` : words.off}`,
    `📅 ${words.weekly}: ${row.weeklyReviewEnabled ? `${weekdayLabel(row.weeklyReviewWeekday, locale)} ${row.weeklyReviewTime}${zone(row.digestTimezone)}` : words.off}`,
    "",
    t(locale, "settings_section_quiet"),
    `🔕 ${words.quietHours}: ${quietHoursLabel(row, locale)}${row.quietHoursEnabled ? zone(row.quietHoursTimezone) : ""}`,
    `💬 ${words.aiHistory}: ${historyMessageCount} ${messageWord(historyMessageCount, locale)}`,
    "",
    words.hint,
  ].join("\n");
}

const SETTINGS_COPY = {
  ru: {
    title: "⚙️ Настройки",
    timezone: "Часовой пояс",
    language: "Язык интерфейса",
    languageAuto: "автоматически (Telegram)",
    morning: "Утренняя сводка",
    weekly: "Еженедельный обзор",
    quietHours: "Тихие часы",
    aiHistory: "История AI",
    quietUntil: "Тишина до",
    off: "выкл",
    hint: "Опиши желаемый результат: время сводок, день еженедельного обзора, язык или тихие часы.",
  },
  uk: {
    title: "⚙️ Налаштування",
    timezone: "Часовий пояс",
    language: "Мова інтерфейсу",
    languageAuto: "автоматично (Telegram)",
    morning: "Ранкове зведення",
    weekly: "Щотижневий огляд",
    quietHours: "Тихі години",
    aiHistory: "Історія AI",
    quietUntil: "Тиша до",
    off: "вимкнено",
    hint: "Опиши бажаний результат: час зведень, день тижневого огляду, мову чи тихі години.",
  },
  en: {
    title: "⚙️ Settings",
    timezone: "Timezone",
    language: "Interface language",
    languageAuto: "automatic (Telegram)",
    morning: "Morning briefing",
    weekly: "Weekly review",
    quietHours: "Quiet hours",
    aiHistory: "AI history",
    quietUntil: "Quiet until",
    off: "off",
    hint: "Describe what you want to change: briefing time, weekly-review day, language, or quiet hours.",
  },
} as const satisfies Record<TelegramLocale, Record<string, string>>;

/** Every toggle the settings card shows is one tap; free text remains for values (times, days). */

/**
 * The task list for one filter. Every line is a group: the recurring series, the three task rows
 * the model created under the same title and the two times of one day each read as one thing, so
 * each shows once with a count of what it hides. `▸` marks a line that opens into that list.
 */
export function tasksOverviewText(
  groups: ReadonlyArray<TelegramGroupCard>,
  options: { scope: TaskScope; total?: number; offset?: number; locale?: TelegramLocale; now?: Date },
): string {
  const locale = options.locale ?? "ru";
  const now = options.now ?? new Date();
  const total = options.total ?? groups.length;
  const offset = options.offset ?? 0;
  const header = t(locale, "tasks_header", { scope: t(locale, SCOPE_COPY[options.scope]), count: total });
  if (!groups.length) return `${header}\n\n${t(locale, "tasks_scope_empty")}`;
  const lines = [header, ""];
  for (const [index, group] of groups.entries()) lines.push(`${offset + index + 1}. ${groupLine(group, now, locale)}`);
  lines.push("", t(locale, "tasks_hint"));
  return compactText(lines.join("\n"), 3_800);
}

/**
 * The week plan: what the past week did, then the pool with a mark on what is taken. A pick left
 * over from an earlier week is marked apart, because that is the decision being avoided.
 */
export function weekPlanText(
  rows: ReadonlyArray<{ title: string; importance: "normal" | "required" | "critical"; pickedWeekStart?: string | null }>,
  options: { locale?: TelegramLocale; todayLocalDate: string; total?: number; offset?: number; summary: { done: number; takenNotStarted: number } },
): string {
  const locale = options.locale ?? "ru";
  const monday = formatDateLabel(targetWeekStart(options.todayLocalDate));
  const header = t(locale, "week_plan_header", { monday, count: options.total ?? rows.length });
  const summary = t(locale, "week_plan_summary", { done: options.summary.done, stale: options.summary.takenNotStarted });
  if (!rows.length) return [header, "", summary, "", t(locale, "week_plan_empty")].join("\n");
  const offset = options.offset ?? 0;
  const lines = [header, "", summary, ""];
  for (const [index, row] of rows.entries()) {
    const mark = isPickLive(row.pickedWeekStart, options.todayLocalDate) ? "☑️" : isPickStale(row.pickedWeekStart, options.todayLocalDate) ? "↩️" : "◻️";
    const icon = importanceIcon(row.importance);
    lines.push(`${offset + index + 1}. ${mark} ${icon ? `${icon} ` : ""}${row.title}`);
  }
  lines.push("", t(locale, "week_plan_hint"));
  return compactText(lines.join("\n"), 3_800);
}

/** Drops one «взято на неделю» line from a morning card whose task has just been given a day. */
export function removeWeekLine(body: string, title: string): string {
  const lines = body.split("\n").filter((line) => line.trim() !== `▸ ${title}`);
  return lines.join("\n");
}

/** Paused series: the title and the rhythm each one will pick up again. */
export function pausedSeriesText(
  rows: ReadonlyArray<{ title: string; recurrenceRule: string | null; recurrenceEndLocalDate?: string | null }>,
  options: { locale?: TelegramLocale; total?: number; offset?: number } = {},
): string {
  const locale = options.locale ?? "ru";
  if (!rows.length) return t(locale, "paused_series_empty");
  const offset = options.offset ?? 0;
  const lines = [t(locale, "paused_series_header", { count: options.total ?? rows.length }), ""];
  for (const [index, row] of rows.entries()) {
    const rhythm = recurrenceLabel(row.recurrenceRule, row.recurrenceEndLocalDate ?? null, locale);
    lines.push(`${offset + index + 1}. 🔁 ${row.title}${rhythm ? ` — ${rhythm}` : ""}`);
  }
  return compactText(lines.join("\n"), 3_800);
}

/** One group opened up: what hid behind the collapsed line, oldest first. */
export function taskGroupText(group: TelegramGroupCard, locale: TelegramLocale = "ru", now: Date = new Date()): string {
  const icon = importanceIcon(group.importance) || (group.recurrenceRule ? "🔁" : "•");
  const lines = [`${icon} ${group.title}`, ""];
  for (const [index, row] of group.rows.entries()) {
    const when = row.occurrence ? occurrenceWhen(row.occurrence, now, locale) : (row.task.fuzzyHorizonText ?? "");
    lines.push(`${index + 1}. ${when || t(locale, "scope_nodate")}${rowState(row, locale)}`);
  }
  lines.push("", t(locale, "tasks_hint"));
  return compactText(lines.join("\n"), 3_800);
}

function groupLine(group: TelegramGroupCard, now: Date, locale: TelegramLocale): string {
  const { lead } = group;
  const icon = importanceIcon(group.importance) || (group.recurrenceRule ? "🔁" : lead.occurrence ? "•" : "🫧");
  const expandable = group.rows.length > 1 ? " ▸" : "";
  return `${icon} ${group.title}${groupWhenLabel(group, now, locale)}${rowState(lead, locale)}${expandable}`;
}

function rowState(row: TelegramTaskListRow, locale: TelegramLocale): string {
  if (row.occurrence?.overdue) return ` · ${t(locale, "scope_overdue")}`;
  if (row.occurrence?.status === "in_progress")
    return ` · ${cardCopy(locale)
      .inProgress.replace(/^\S+\s/u, "")
      .toLowerCase()}`;
  return "";
}

/**
 * Upcoming reminders read as a calendar, not as a flat queue: one heading per local day, and a
 * task with several reminders in a day takes one line with its times instead of one line each.
 */
export function remindersText(rows: ReadonlyArray<ReminderListRow>, options: { locale?: TelegramLocale; timezone: string; now?: Date }): string {
  const locale = options.locale ?? "ru";
  const now = options.now ?? new Date();
  const today = localDateAt(now, options.timezone);
  const lines = [t(locale, "reminders_title")];
  for (const [localDate, dayRows] of reminderDays(rows)) {
    lines.push("", dayHeading(localDate, today, locale));
    for (const [title, titleRows] of groupByTitle(dayRows)) {
      const times = titleRows.map((row) => formatTime(new Date(row.delivery.scheduledFor), row.task.timezone, locale));
      lines.push(`• ${title} · ${times.join(", ")}`);
    }
  }
  lines.push("", t(locale, "reminders_hint"));
  return compactText(lines.join("\n"), 3_800);
}

export interface ReminderListRow {
  delivery: { id: string; scheduledFor: Date };
  task: { title: string; timezone: string };
}

/** Local days in order, each with its reminders in order. */
export function reminderDays(rows: ReadonlyArray<ReminderListRow>): Array<[string, ReminderListRow[]]> {
  const days = new Map<string, ReminderListRow[]>();
  for (const row of rows) {
    const localDate = localDateAt(new Date(row.delivery.scheduledFor), row.task.timezone);
    const bucket = days.get(localDate);
    if (bucket) bucket.push(row);
    else days.set(localDate, [row]);
  }
  return [...days.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function groupByTitle(rows: ReadonlyArray<ReminderListRow>): Array<[string, ReminderListRow[]]> {
  const byTitle = new Map<string, ReminderListRow[]>();
  for (const row of rows) {
    const bucket = byTitle.get(row.task.title);
    if (bucket) bucket.push(row);
    else byTitle.set(row.task.title, [row]);
  }
  return [...byTitle.entries()];
}

function dayHeading(localDate: string, today: string, locale: TelegramLocale): string {
  if (localDate === today) return t(locale, "reminders_day_today");
  if (localDate === shiftLocalDate(today, 1)) return t(locale, "reminders_day_tomorrow");
  return `${weekdayLabel(isoWeekday(localDate), locale)} ${formatDateLabel(localDate)}`;
}

function isoWeekday(localDate: string): number {
  const { year, month, day } = parseLocalDate(localDate);
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

const SCOPE_COPY = {
  overdue: "scope_overdue",
  today: "scope_today",
  week: "scope_week",
  month: "scope_month",
  all: "scope_all",
  nodate: "scope_nodate",
} as const satisfies Record<TaskScope, CopyKey>;

/** Opens the numbered item shown in a compact overview. */

/**
 * Today is the day itself. Work dated before it is counted at the bottom and opened through the
 * overdue filter: an occurrence stays overdue until it is closed, so weeks of unclosed work used
 * to sit here as if it were planned for today.
 */
export function todayText(
  groups: ReadonlyArray<TelegramGroupCard>,
  localDate: string,
  options: { locale?: TelegramLocale; completedCount?: number; staleCount?: number; total?: number; offset?: number; now?: Date } = {},
): string {
  const locale = options.locale ?? "ru";
  const now = options.now ?? new Date();
  const completedCount = options.completedCount ?? 0;
  const staleCount = options.staleCount ?? 0;
  const total = options.total ?? groups.length;
  const offset = options.offset ?? 0;
  const title = locale === "en" ? "☀️ Today" : locale === "uk" ? "☀️ Сьогодні" : "☀️ Сегодня";
  const footer: string[] = [];
  if (completedCount) footer.push(`\n✅ ${locale === "en" ? "Completed today" : locale === "uk" ? "Виконано сьогодні" : "Выполнено сегодня"}: ${completedCount}`);
  if (staleCount) footer.push(`\n${t(locale, "today_stale", { count: staleCount })}`);
  if (!groups.length) {
    return [title, "", t(locale, "nothing_planned"), ...footer].join("\n");
  }
  const main = groups.find((group) => group.importance !== "normal") ?? groups[0];
  const lines = [`${title} · ${total} ${taskWord(total, locale)}`];
  if (main && !offset) lines.push(`\n${t(locale, "label_main")}: ${main.title}`);
  lines.push("");
  for (const [index, group] of groups.entries()) lines.push(`${offset + index + 1}. ${todayGroupLine(group, localDate, locale, now)}`);
  lines.push(...footer);
  return compactText(lines.join("\n"), 3_800);
}

function todayGroupLine(group: TelegramGroupCard, localDate: string, locale: TelegramLocale, now: Date): string {
  // A single row keeps the day-local wording ("до 18:00"); several rows on one day list their times.
  if (group.rows.length < 2) return todayLine(group.lead.task, group.lead.occurrence, localDate, locale, now);
  return groupLine(group, now, locale);
}

export interface GoalListItem {
  goal: { id: string; title: string; status: "active" | "paused" | "completed" | "cancelled"; why: string | null; targetLocalDate: string | null };
  tasks: Array<{ id?: string; title: string; nextAction: string | null; context: string | null; dueLocalDate: string | null }>;
}

/**
 * The goal list stays scannable: one line per goal with how much of it is planned, and the tasks
 * themselves live on the goal's own screen. Printing four tasks under each of eight goals made
 * this the longest message the bot sends and hid the goals it was supposed to show.
 */
export function goalsOverviewText(rows: ReadonlyArray<GoalListItem>, options: { scope: GoalScope; total?: number; offset?: number; locale?: TelegramLocale }): string {
  const locale = options.locale ?? "ru";
  const total = options.total ?? rows.length;
  const offset = options.offset ?? 0;
  const header = t(locale, "goals_header", { scope: t(locale, GOAL_SCOPE_COPY[options.scope]), count: total });
  if (!rows.length) return `${header}\n\n${t(locale, "goals_empty_scope")}`;
  const lines = [header, ""];
  for (const [index, row] of rows.entries()) {
    const deadline = row.goal.targetLocalDate ? ` · ${t(locale, "goal_deadline", { date: formatDateLabel(row.goal.targetLocalDate) })}` : "";
    const tasks = row.tasks.length ? plural(locale, row.tasks.length, "task") : t(locale, "goals_no_tasks");
    lines.push(`${offset + index + 1}. ${row.goal.title}${deadline}`, `   ${tasks}`);
  }
  lines.push("", t(locale, "goals_hint"));
  return compactText(lines.join("\n"), 3_800);
}

/** One goal opened up: why it exists and every active task linked to it. */
export function goalDetailText(row: GoalListItem, locale: TelegramLocale = "ru"): string {
  const deadline = row.goal.targetLocalDate ? ` · ${t(locale, "goal_deadline", { date: formatDateLabel(row.goal.targetLocalDate) })}` : "";
  const lines = [`🎯 ${row.goal.title}${deadline}`];
  if (row.goal.why) lines.push(`${t(locale, "goal_why")}: ${compactText(row.goal.why, 300)}`);
  lines.push("");
  if (!row.tasks.length) lines.push(`• ${t(locale, "goals_no_tasks")}`);
  for (const task of row.tasks) {
    const details = selectCardDetails(task);
    const detail = details.nextAction ?? details.context ?? (task.dueLocalDate ? t(locale, "goal_deadline", { date: formatDateLabel(task.dueLocalDate) }) : null);
    lines.push(`• ${task.title}${detail ? ` — ${detail}` : ""}`);
  }
  lines.push("", t(locale, "goals_hint"));
  return compactText(lines.join("\n"), 3_800);
}

const GOAL_SCOPE_COPY = {
  active: "goals_scope_active",
  paused: "goals_scope_paused",
  completed: "goals_scope_completed",
} as const satisfies Record<GoalScope, CopyKey>;
