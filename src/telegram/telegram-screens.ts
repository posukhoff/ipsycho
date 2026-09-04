import { compactText } from "../core/telegram-ux.js";
import { selectCardDetails } from "../core/card-details.js";
import type { TelegramLocale } from "./telegram-locale.js";
import { todayLine } from "./telegram-cards.js";
import {
  formatLocal,
  importanceIcon,
  messageWord,
  overviewWhen,
  quietHoursLabel,
  taskWord,
  weekdayLabel,
  type TelegramOccurrenceCard,
  type TelegramTaskCard,
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

export function tasksOverviewText(
  rows: Array<{ task: TelegramTaskCard & { id: string }; occurrence: TelegramOccurrenceCard | null }>,
  locale: TelegramLocale = "ru",
  now: Date = new Date(),
): string {
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
      lines.push(`${index + 1}. ${icon} ${row.task.title}${overviewWhen(row.task, row.occurrence, now, locale)}${state}`);
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
    lines.push(`${index + 1}. ${icon} ${row.task.title}${overviewWhen(row.task, row.occurrence, now, locale)}${state}`);
  }
  if (uniqueRows.length > 8) lines.push(uk ? `+ ще ${uniqueRows.length - 8}` : `+ ещё ${uniqueRows.length - 8}`);
  lines.push(
    "",
    uk ? "Щоб змінити, завершити або перенести завдання, напиши це звичайним повідомленням." : "Чтобы изменить, завершить или перенести задачу, напиши это обычным сообщением.",
  );
  return lines.join("\n");
}

/** Opens the numbered item shown in a compact overview. */

export function todayText(
  rows: Array<{ task: TelegramTaskCard; occurrence: TelegramOccurrenceCard | null }>,
  localDate: string,
  locale: TelegramLocale = "ru",
  completedCount = 0,
  visibleLimit = 6,
  now: Date = new Date(),
): string {
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
