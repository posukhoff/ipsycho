import { InlineKeyboard } from "grammy";
import { compactText } from "../core/telegram-ux.js";
import { localDateAt } from "../core/timezone.js";
import type { TelegramLocale } from "./telegram-locale.js";

export type TelegramImportance = "normal" | "required" | "critical";
export type TelegramOccurrenceStatus = "scheduled" | "open" | "in_progress" | "done" | "skipped" | "cancelled" | "elapsed";

export interface TelegramTaskCard {
  title: string;
  importance: TelegramImportance;
  recurrenceRule?: string | null;
  fuzzyHorizonText?: string | null;
  reviewAt?: Date | string | null;
  timezone: string;
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

export function taskCardText(task: TelegramTaskCard, occurrence: TelegramOccurrenceCard): string {
  const title = `${importanceIcon(task.importance)} ${task.title}`.trim();
  const meta = taskMeta(task, occurrence);
  const status = occurrence.status === "in_progress" ? "▶️ В работе" : occurrence.overdue ? "⚠️ Просрочено" : "";
  return [title, meta, status].filter(Boolean).join("\n");
}

export function fuzzyTaskCardText(task: TelegramTaskCard): string {
  const title = `${importanceIcon(task.importance)} ${task.title}`.trim();
  const horizon = task.fuzzyHorizonText ? `🫧 ${task.fuzzyHorizonText}` : "🫧 Без точной даты";
  const review = task.reviewAt ? `Вернуться: ${formatLocal(new Date(task.reviewAt), task.timezone)}` : "";
  return [title, horizon, review].filter(Boolean).join("\n");
}

export function reminderCardText(input: {
  task: TelegramTaskCard;
  occurrence?: TelegramOccurrenceCard | null;
  purpose: "user_reminder" | "planning_review" | "follow_up";
  now: Date;
}): string {
  const icon = input.purpose === "planning_review" ? "🗓" : input.purpose === "follow_up" ? "↩️" : "🔔";
  const title = `${icon} ${input.task.title}`;
  const prompt = input.purpose === "planning_review" ? "Пора решить, когда вернуться к задаче."
    : input.purpose === "follow_up" && input.occurrence?.status === "in_progress" ? "Как идёт?" : "";
  if (!input.occurrence) return [title, prompt].filter(Boolean).join("\n");
  const meta = taskMeta(input.task, input.occurrence);
  const relative = relativeDue(input.occurrence, input.now);
  return [title, meta, relative, prompt].filter(Boolean).join("\n");
}

export function taskKeyboard(occurrenceId: string, status: TelegramOccurrenceStatus): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (status !== "in_progress") keyboard.text("▶️ Начать", `occ:start:${occurrenceId}`);
  keyboard.text("✅ Готово", `occ:done:${occurrenceId}`).row();
  keyboard.text("🕒 Позже", `occ:resched:${occurrenceId}`).text("•••", `occ:more:${occurrenceId}`);
  return keyboard;
}

export function startedTaskKeyboard(occurrenceId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Готово", `occ:done:${occurrenceId}`)
    .text("🕒 Позже", `occ:resched:${occurrenceId}`)
    .row()
    .text("🧱 Застрял", `occ:cant:${occurrenceId}`)
    .text("•••", `occ:more:${occurrenceId}`);
}

export function taskMoreKeyboard(occurrenceId: string, status: TelegramOccurrenceStatus, recurring = false, taskId?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (status === "in_progress") keyboard.text("🔔 Проверить", `occ:check:${occurrenceId}`).row();
  if (recurring) keyboard.text("⏭ Пропустить это", `occ:skip:${occurrenceId}`).row();
  if (recurring && taskId) keyboard.text("⏸ Поставить серию на паузу", `series:pause:${taskId}`).row();
  return keyboard
    .text("🧱 Застрял", `occ:cant:${occurrenceId}`)
    .text("❌ Отменить", `occ:cancel:${occurrenceId}`)
    .row()
    .text("← Назад", `occ:back:${occurrenceId}`);
}

export function quickRescheduleKeyboard(occurrenceId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("+1 час", `resched:1h:${occurrenceId}`)
    .text("Вечером", `resched:evening:${occurrenceId}`)
    .row()
    .text("Завтра", `resched:tomorrow:${occurrenceId}`)
    .text("📅 Другая дата", `resched:custom:${occurrenceId}`)
    .row()
    .text("← Назад", `occ:back:${occurrenceId}`);
}


export type QuickRescheduleReasonCode = "time" | "dependency" | "energy" | "other";

export function quickRescheduleReasonKeyboard(occurrenceId: string, choice: "1h" | "evening" | "tomorrow"): InlineKeyboard {
  const choiceCode = choice === "1h" ? "h" : choice === "evening" ? "e" : "t";
  return new InlineKeyboard()
    .text("Не успеваю", `rr:${choiceCode}:t:${occurrenceId}`)
    .text("Зависит от другого", `rr:${choiceCode}:d:${occurrenceId}`)
    .row()
    .text("Нет сил", `rr:${choiceCode}:e:${occurrenceId}`)
    .text("Другое", `rr:${choiceCode}:o:${occurrenceId}`)
    .row()
    .text("← Назад", `occ:resched:${occurrenceId}`);
}

export function quickRescheduleReasonText(code: QuickRescheduleReasonCode): string | null {
  if (code === "time") return "Не успеваю";
  if (code === "dependency") return "Зависит от другого";
  if (code === "energy") return "Нет сил";
  return null;
}

export function resultCheckKeyboard(occurrenceId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Через 15 мин", `follow:result:15m:${occurrenceId}`)
    .text("Через 1 час", `follow:result:1h:${occurrenceId}`)
    .row()
    .text("Вечером", `follow:result:evening:${occurrenceId}`)
    .text("Без проверки", `follow:result:none:${occurrenceId}`)
    .row()
    .text("← Назад", `occ:back:${occurrenceId}`);
}

export function terminalTaskText(task: TelegramTaskCard, status: "done" | "skipped" | "cancelled", now: Date): string {
  if (status === "done") return `✅ ${task.title}\nГотово · ${formatTime(now, task.timezone)}`;
  if (status === "skipped") return `⏭ ${task.title}\nПропущено`;
  return `❌ ${task.title}\nОтменено`;
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
    `${uk ? "💬 Історія AI" : "💬 История AI"}: ${historyMessageCount} ${messageWord(historyMessageCount, locale)}`,
    "",
    uk ? "Опиши бажаний результат: час зведень, день тижневого огляду, мову чи тихі години." : "Опиши желаемый результат: время сводок, день еженедельного обзора, язык или тихие часы.",
  ].join("\n");
}

export function settingsKeyboard(locale: TelegramLocale = "ru"): InlineKeyboard {
  if (locale === "en") return new InlineKeyboard()
    .text("🔕 Until morning", "prefs:snooze:morning").row()
    .text("🧭 Context", "profile:open").row()
    .text("🧠 Clear AI history", "history:clear");
  const uk = locale === "uk";
  return new InlineKeyboard()
    .text(uk ? "🔕 До ранку" : "🔕 До утра", "prefs:snooze:morning")
    .row()
    .text(uk ? "🧭 Контекст" : "🧭 Контекст", "profile:open")
    .row()
    .text(uk ? "🧠 Очистити AI-історію" : "🧠 Очистить AI-историю", "history:clear");
}

export function tasksOverviewText(rows: Array<{ task: TelegramTaskCard & { id: string }; occurrence: TelegramOccurrenceCard | null }>, locale: TelegramLocale = "ru"): string {
  // The overview is task-oriented: a recurring task may have many future
  // occurrences, but it must appear only once here. The Today screen below is
  // occurrence-oriented and intentionally keeps every same-day instance.
  const uniqueRows = rows.filter((row, index) => rows.findIndex((candidate) => candidate.task.id === row.task.id) === index);
  if (locale === "en") {
    if (!uniqueRows.length) return "📋 Tasks\n\nNo active tasks.";
    const lines = ["📋 Tasks", ""];
    for (const [index, row] of uniqueRows.slice(0, 8).entries()) {
      const icon = importanceIcon(row.task.importance) || (row.task.recurrenceRule ? "🔁" : row.occurrence ? "•" : "🫧");
      const state = row.occurrence?.overdue ? " · overdue" : row.occurrence?.status === "in_progress" ? " · in progress" : row.task.fuzzyHorizonText ? ` · ${row.task.fuzzyHorizonText}` : "";
      lines.push(`${index + 1}. ${icon} ${row.task.title}${state}`);
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
    const state = row.occurrence?.overdue ? (uk ? " · прострочено" : " · просрочено") : row.occurrence?.status === "in_progress" ? (uk ? " · у роботі" : " · в работе") : row.task.fuzzyHorizonText ? ` · ${row.task.fuzzyHorizonText}` : "";
    lines.push(`${index + 1}. ${icon} ${row.task.title}${state}`);
  }
  if (uniqueRows.length > 8) lines.push(uk ? `+ ще ${uniqueRows.length - 8}` : `+ ещё ${uniqueRows.length - 8}`);
  lines.push("", uk ? "Щоб змінити, завершити або перенести завдання, напиши це звичайним повідомленням." : "Чтобы изменить, завершить или перенести задачу, напиши это обычным сообщением.");
  return lines.join("\n");
}

/** Opens the numbered item shown in a compact overview. */
export function taskListKeyboard(rows: TelegramTaskListRow[], locale: TelegramLocale = "ru", options: { showAll?: boolean; allCount?: number; visibleCount?: number } = {}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const visible = rows.slice(0, options.visibleCount ?? 6);
  for (const [index, row] of visible.entries()) {
    const target = row.occurrence ? `view:occ:${row.occurrence.id}` : `view:task:${row.task.id}`;
    const title = row.task.title.length > 22 ? `${row.task.title.slice(0, 21)}…` : row.task.title;
    keyboard.text(`${index + 1}. ${title}`, target).row();
  }
  if (options.showAll && (options.allCount ?? rows.length) > visible.length) {
    const label = locale === "en" ? `Show all (${options.allCount})` : locale === "uk" ? `Показати всі (${options.allCount})` : `Показать все (${options.allCount})`;
    keyboard.text(label, "nav:today_all").row();
  }
  const tasksLabel = locale === "en" ? "📋 All tasks" : locale === "uk" ? "📋 Усі завдання" : "📋 Все задачи";
  const todayLabel = locale === "en" ? "☀️ Today" : locale === "uk" ? "☀️ Сьогодні" : "☀️ Сегодня";
  keyboard.text(todayLabel, "nav:today").text(tasksLabel, "nav:tasks");
  return keyboard;
}

export function taskDetailKeyboard(occurrenceId: string, status: TelegramOccurrenceStatus): InlineKeyboard {
  const keyboard = status === "in_progress" ? startedTaskKeyboard(occurrenceId) : taskKeyboard(occurrenceId, status);
  return keyboard.row().text("← К задачам", "nav:tasks");
}

export function fuzzyTaskDetailKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("← К задачам", "nav:tasks").text("☀️ Сегодня", "nav:today");
}

export function todayText(rows: Array<{ task: TelegramTaskCard; occurrence: TelegramOccurrenceCard }>, localDate: string, locale: TelegramLocale = "ru", completedCount = 0, visibleLimit = 6): string {
  if (locale === "en") {
    if (!rows.length) return "☀️ Today\n\nNothing is planned.";
    const top = rows.slice(0, visibleLimit);
    const main = top.find(({ task }) => task.importance !== "normal") ?? top[0];
    const lines = [`☀️ Today · ${rows.length} ${taskWord(rows.length, locale)}`];
    if (main) lines.push(`\nMain: ${main.task.title}`);
    lines.push("");
    for (const { task, occurrence } of top) lines.push(todayLine(task, occurrence, localDate, locale));
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
  for (const { task, occurrence } of top) lines.push(todayLine(task, occurrence, localDate, locale));
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
        const detailValue = task.nextAction ?? task.context ?? (task.dueLocalDate ? `by ${task.dueLocalDate}` : null);
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
        const detailValue = task.nextAction ?? task.context ?? (task.dueLocalDate ? `до ${task.dueLocalDate}` : null);
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

function todayLine(task: TelegramTaskCard, occurrence: TelegramOccurrenceCard, localDate: string, locale: TelegramLocale): string {
  const icon = importanceIcon(task.importance) || (task.recurrenceRule ? "🔁" : "•");
  const label = occurrence.overdue ? (locale === "en" ? " · overdue" : locale === "uk" ? " · прострочено" : " · просрочено") : occurrence.dueAt ? ` · ${locale === "en" ? "by" : "до"} ${formatTime(new Date(occurrence.dueAt), occurrence.timezone)}`
    : occurrence.plannedStartAt && localDateAt(new Date(occurrence.plannedStartAt), occurrence.timezone) === localDate
      ? ` · ${formatTime(new Date(occurrence.plannedStartAt), occurrence.timezone)}` : "";
  return `${icon} ${task.title}${label}`;
}

function taskMeta(task: TelegramTaskCard, occurrence: TelegramOccurrenceCard): string {
  const recurrence = task.recurrenceRule ? "🔁 " : "";
  if (occurrence.dueAt) return `${recurrence}до ${formatLocal(new Date(occurrence.dueAt), occurrence.timezone)}`;
  if (occurrence.dueLocalDate) return `${recurrence}до ${formatDateLabel(occurrence.dueLocalDate)}`;
  if (occurrence.plannedStartAt && occurrence.plannedEndAt) return `${recurrence}${formatLocal(new Date(occurrence.plannedStartAt), occurrence.timezone)}–${formatTime(new Date(occurrence.plannedEndAt), occurrence.timezone)}`;
  if (occurrence.plannedStartAt) return `${recurrence}${formatLocal(new Date(occurrence.plannedStartAt), occurrence.timezone)}`;
  if (occurrence.plannedLocalDate) return `${recurrence}${formatDateLabel(occurrence.plannedLocalDate)}`;
  return recurrence.trim();
}

function relativeDue(occurrence: TelegramOccurrenceCard, now: Date): string {
  const target = occurrence.dueAt ? new Date(occurrence.dueAt) : occurrence.plannedStartAt ? new Date(occurrence.plannedStartAt) : null;
  if (!target) return occurrence.overdue ? "⚠️ Просрочено" : "";
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (minutes < 0) return "⚠️ Просрочено";
  if (minutes < 60) return `через ${Math.max(1, minutes)} мин`;
  if (minutes < 24 * 60) return `через ${Math.round(minutes / 60)} ч`;
  return "";
}

function importanceIcon(importance: TelegramImportance): string {
  return importance === "critical" ? "🔴" : importance === "required" ? "🟡" : "";
}

function formatLocal(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(at);
}

function formatTime(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(at);
}

function formatDateLabel(value: string): string {
  const [year, month, day] = value.split("-");
  return day && month && year ? `${day}.${month}` : value;
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

function weekdayLabel(value: number, locale: TelegramLocale): string {
  const labels = locale === "en"
    ? ["?", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    : locale === "uk"
    ? ["?", "пн", "вт", "ср", "чт", "пт", "сб", "нд"]
    : ["?", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
  return labels[value] ?? String(value);
}
