import { compactText } from "../core/telegram-ux.js";
import { selectCardDetails } from "../core/card-details.js";
import type { TaskScope } from "../core/task-list-view.js";
import { t, type CopyKey } from "./copy/index.js";
import type { TelegramLocale } from "./telegram-locale.js";
import { todayLine } from "./telegram-cards.js";
import {
  cardCopy,
  formatLocal,
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
export function settingsText(
  row: {
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
  },
  now = new Date(),
  historyMessageCount = 0,
  locale: TelegramLocale = "ru",
): string {
  if (locale === "en") {
    const snoozed = row.notificationsSnoozedUntil && row.notificationsSnoozedUntil > now ? `\n🔕 Quiet until ${formatLocal(row.notificationsSnoozedUntil, row.timezone)}` : "";
    return [
      "⚙️ Settings",
      "",
      `🌍 Timezone: ${row.timezone}${snoozed}`,
      `🗣 Interface language: ${row.pinnedLanguage ?? "automatic (Telegram)"}`,
      `☀️ Morning briefing: ${row.morningDigestEnabled ? row.morningReferenceTime : "off"}`,
      `🌙 Evening briefing: ${row.eveningDigestEnabled ? row.eveningReferenceTime : "off"}`,
      `📅 Weekly review: ${row.weeklyReviewEnabled ? `${weekdayLabel(row.weeklyReviewWeekday, locale)} ${row.weeklyReviewTime}` : "off"}`,
      `🔕 Quiet hours: ${quietHoursLabel(row, locale)}`,
      `💬 AI history: ${historyMessageCount} ${messageWord(historyMessageCount, locale)}`,
      "",
      "Describe what you want to change: briefing time, weekly-review day, language, or quiet hours.",
    ].join("\n");
  }
  const uk = locale === "uk";
  const snoozed =
    row.notificationsSnoozedUntil && row.notificationsSnoozedUntil > now
      ? `\n🔕 ${locale === "uk" ? "Тиша до" : "Тишина до"} ${formatLocal(row.notificationsSnoozedUntil, row.timezone)}`
      : "";
  return [
    uk ? "⚙️ Налаштування" : "⚙️ Настройки",
    "",
    `${uk ? "🌍 Часовий пояс" : "🌍 Часовой пояс"}: ${row.timezone}${snoozed}`,
    `${uk ? "🗣 Мова інтерфейсу" : "🗣 Язык интерфейса"}: ${row.pinnedLanguage ?? (uk ? "автоматично (Telegram)" : "автоматически (Telegram)")}`,
    `${uk ? "☀️ Ранкове зведення" : "☀️ Утренняя сводка"}: ${row.morningDigestEnabled ? row.morningReferenceTime : uk ? "вимкнено" : "выкл"}`,
    `${uk ? "🌙 Вечірнє зведення" : "🌙 Вечерняя сводка"}: ${row.eveningDigestEnabled ? row.eveningReferenceTime : uk ? "вимкнено" : "выкл"}`,
    `${uk ? "📅 Щотижневий огляд" : "📅 Еженедельный обзор"}: ${row.weeklyReviewEnabled ? `${weekdayLabel(row.weeklyReviewWeekday, locale)} ${row.weeklyReviewTime}` : uk ? "вимкнено" : "выкл"}`,
    `${uk ? "🔕 Тихі години" : "🔕 Тихие часы"}: ${quietHoursLabel(row, locale)}`,
    `${uk ? "💬 Історія AI" : "💬 История AI"}: ${historyMessageCount} ${messageWord(historyMessageCount, locale)}`,
    "",
    uk
      ? "Опиши бажаний результат: час зведень, день тижневого огляду, мову чи тихі години."
      : "Опиши желаемый результат: время сводок, день еженедельного обзора, язык или тихие часы.",
  ].join("\n");
}

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
    const empty = locale === "en" ? "Nothing is planned." : locale === "uk" ? "Запланованих справ немає." : "Запланированных дел нет.";
    return [title, "", empty, ...footer].join("\n");
  }
  const main = groups.find((group) => group.importance !== "normal") ?? groups[0];
  const lines = [`${title} · ${total} ${taskWord(total, locale)}`];
  if (main && !offset) lines.push(`\n${locale === "en" ? "Main" : locale === "uk" ? "Головне" : "Главное"}: ${main.title}`);
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

export function goalsOverviewText(
  rows: Array<{
    goal: { title: string; status: "active" | "paused" | "completed" | "cancelled"; why: string | null; targetLocalDate: string | null };
    tasks: Array<{ title: string; nextAction: string | null; context: string | null; dueLocalDate: string | null }>;
  }>,
  locale: TelegramLocale = "ru",
): string {
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
  if (!rows.length)
    return uk
      ? "🎯 Цілі\n\nЦілей поки немає. Напиши, наприклад: «Хочу підготуватися до напівмарафону»."
      : "🎯 Цели\n\nЦелей пока нет. Напиши, например: «Хочу подготовиться к полумарафону».";
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
