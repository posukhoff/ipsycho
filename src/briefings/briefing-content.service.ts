import { Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { occurrenceFallsOnLocalDate } from "../core/local-schedule.js";
import { importanceRank } from "../core/types.js";
import { DatabaseService } from "../database/database.service.js";
import { todayLine } from "../telegram/telegram-ui.js";
import type { TelegramLocale } from "../telegram/telegram-locale.js";
import { compactText } from "../core/telegram-ux.js";
import { currentWeekStart, previousWeekRange } from "../core/week-plan.js";
import { briefingDeliveries, taskOccurrences, tasks } from "../database/schema.js";

const NONTERMINAL = ["scheduled", "open", "in_progress"] as const;
/** Telegram's hard limit is 4096; a weekly review with many goals and habits must stay under it. */
const BRIEFING_MAX_CHARS = 3_900;

const COPY = {
  ru: {
    takenThisWeek: "Взято на неделю:",
    weekPlanCta: "Открыть план недели: /week",
    weekSummary: (done: number, stale: number) => `За прошлую неделю закрыто: ${done}. Взято и не начато: ${stale}.`,
    weekPoolEmpty: "В пуле нет задач без даты.",
    weeklyPick: "🗂 План недели",
    morningEmpty: "☀️ Сегодня\n\nЗапланированных дел нет.",
    morning: "☀️ Сегодня",
    main: "Главное",
    more: (n: number) => `+ ещё ${n}`,
    eveningEmpty: "🌙 Вечер\n\nНа сегодня всё закрыто.",
    evening: "🌙 Вечер",
    left: "Осталось",
    decide: "Нужно решить:",
    rest: "Остальное:",
    weeklyEmpty: "📅 Недельный обзор\n\nСейчас нет активных целей, привычек или движения для обзора.",
    weekly: "📅 Недельный обзор",
    goals: "🎯 Цели",
    goalFact: (done: number, active: number) => `выполнений: ${done}; активных задач: ${active}.`,
    planning: "🗓 Планирование ближайшей недели",
    urgency: { urgent: "срочно", high: "на этой неделе", watch: "скоро", overdue: "просрочено" },
    nextStep: "следующий шаг",
    context: "контекст",
    movement: "📈 Движение по завершённым или приостановленным целям",
    done: "выполнено",
    rescheduled: "перенесено",
    focus: "💡 Фокус на неделю",
    blocked: (goal: string) => `У цели «${goal}» были повторные переносы или сложности со стартом.`,
    focusStep: "Следующий шаг",
    defaultStep: "сформулировать одну небольшую задачу на ближайшую неделю",
    habits: "🔁 Привычки за последние 7 дней",
    fewData: "пока мало данных",
    habitRate: (done: number, total: number, rate: number) => `${done}/${total} выполнено (${rate}%)`,
    misses: (n: number) => `Повторные пропуски: ${n}. Это только наблюдение для следующего разбора.`,
    tasks: (n: number) => `${n} ${plural(n, "дело", "дела", "дел")}`,
  },
  uk: {
    takenThisWeek: "Взято на тиждень:",
    weekPlanCta: "Відкрити план тижня: /week",
    weekSummary: (done: number, stale: number) => `За минулий тиждень закрито: ${done}. Взято й не почато: ${stale}.`,
    weekPoolEmpty: "У пулі немає завдань без дати.",
    weeklyPick: "🗂 План тижня",
    morningEmpty: "☀️ Сьогодні\n\nЗапланованих справ немає.",
    morning: "☀️ Сьогодні",
    main: "Головне",
    more: (n: number) => `+ ще ${n}`,
    eveningEmpty: "🌙 Вечір\n\nНа сьогодні все закрито.",
    evening: "🌙 Вечір",
    left: "Залишилось",
    decide: "Треба вирішити:",
    rest: "Решта:",
    weeklyEmpty: "📅 Тижневий огляд\n\nЗараз немає активних цілей, звичок або руху для огляду.",
    weekly: "📅 Тижневий огляд",
    goals: "🎯 Цілі",
    goalFact: (done: number, active: number) => `виконань: ${done}; активних завдань: ${active}.`,
    planning: "🗓 Планування найближчого тижня",
    urgency: { urgent: "терміново", high: "цього тижня", watch: "скоро", overdue: "прострочено" },
    nextStep: "наступний крок",
    context: "контекст",
    movement: "📈 Рух за завершеними або призупиненими цілями",
    done: "виконано",
    rescheduled: "перенесено",
    focus: "💡 Фокус на тиждень",
    blocked: (goal: string) => `У цілі «${goal}» були повторні перенесення або складнощі зі стартом.`,
    focusStep: "Наступний крок",
    defaultStep: "сформулювати одне невелике завдання на найближчий тиждень",
    habits: "🔁 Звички за останні 7 днів",
    fewData: "поки мало даних",
    habitRate: (done: number, total: number, rate: number) => `${done}/${total} виконано (${rate}%)`,
    misses: (n: number) => `Повторні пропуски: ${n}. Це лише спостереження для наступного розбору.`,
    tasks: (n: number) => `${n} ${plural(n, "справа", "справи", "справ")}`,
  },
  en: {
    takenThisWeek: "Taken this week:",
    weekPlanCta: "Open the week plan: /week",
    weekSummary: (done: number, stale: number) => `Closed last week: ${done}. Taken and not started: ${stale}.`,
    weekPoolEmpty: "The pool has no undated tasks.",
    weeklyPick: "🗂 Week plan",
    morningEmpty: "☀️ Today\n\nNothing is planned.",
    morning: "☀️ Today",
    main: "Main",
    more: (n: number) => `+ ${n} more`,
    eveningEmpty: "🌙 Evening\n\nEverything for today is closed.",
    evening: "🌙 Evening",
    left: "Left",
    decide: "Needs a decision:",
    rest: "The rest:",
    weeklyEmpty: "📅 Weekly review\n\nNo active goals, habits or movement to review right now.",
    weekly: "📅 Weekly review",
    goals: "🎯 Goals",
    goalFact: (done: number, active: number) => `completions: ${done}; active tasks: ${active}.`,
    planning: "🗓 Planning the coming week",
    urgency: { urgent: "urgent", high: "this week", watch: "soon", overdue: "overdue" },
    nextStep: "next step",
    context: "context",
    movement: "📈 Movement on completed or paused goals",
    done: "done",
    rescheduled: "moved",
    focus: "💡 Focus for the week",
    blocked: (goal: string) => `Goal “${goal}” had repeated moves or trouble getting started.`,
    focusStep: "Next step",
    defaultStep: "define one small task for the coming week",
    habits: "🔁 Habits over the last 7 days",
    fewData: "not enough data yet",
    habitRate: (done: number, total: number, rate: number) => `${done}/${total} done (${rate}%)`,
    misses: (n: number) => `Repeated misses: ${n}. Just an observation for the next review.`,
    tasks: (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`,
  },
} as const;

@Injectable()
export class BriefingContentService {
  constructor(private readonly database: DatabaseService) {}

  async build(input: { workspaceId: string; kind: "morning" | "evening" | "weekly" | "evening_weekly"; localDate: string; timezone: string; now?: Date; locale?: TelegramLocale }) {
    const locale: TelegramLocale = input.locale ?? "ru";
    const c = COPY[locale];
    const bounded = <T extends { text: string }>(result: T): T => ({ ...result, text: compactText(result.text, BRIEFING_MAX_CHARS) });
    const occurrenceRows = await this.database.db
      .select({ task: tasks, occurrence: taskOccurrences })
      .from(taskOccurrences)
      .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
      .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(tasks.status, "active"), inArray(taskOccurrences.status, [...NONTERMINAL])));

    const relevant = occurrenceRows.filter(({ task, occurrence }) => occurrenceFallsOnLocalDate({ ...occurrence, timeMode: task.timeMode }, input.localDate));

    // Tasks taken for this week and still without a day: the morning card is where a day is given
    // to one of them, so it lists them under what is already scheduled.
    const pickedForWeek = await this.database.db
      .select({ id: tasks.id, title: tasks.title, importance: tasks.importance })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.status, "active"), eq(tasks.timeMode, "fuzzy"), eq(tasks.pickedWeekStart, currentWeekStart(input.localDate))))
      .orderBy(tasks.updatedAt);

    const morning = () => {
      const ordered = [...relevant].sort((a, b) => importanceRank(a.task.importance) - importanceRank(b.task.importance));
      const weekLines = pickedForWeek.length ? ["", c.takenThisWeek, ...pickedForWeek.slice(0, 8).map((task) => `▸ ${task.title}`)] : [];
      const weekTasks = pickedForWeek.slice(0, 8).map((task) => ({ id: task.id, title: task.title }));
      if (!ordered.length) {
        if (!weekLines.length) return { text: c.morningEmpty, hasContent: false, reviewKinds: [] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[], weekTasks };
        return { text: [c.morning, ...weekLines].join("\n"), hasContent: true, reviewKinds: [] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[], weekTasks };
      }
      const main = ordered.find(({ task }) => task.importance !== "normal") ?? ordered[0];
      const lines = [`${c.morning} · ${c.tasks(ordered.length)}`];
      if (main) lines.push(`\n${c.main}: ${main.task.title}`);
      lines.push("");
      for (const row of ordered.slice(0, 6)) lines.push(todayLine(row.task, row.occurrence, input.localDate, locale, input.now ?? new Date()));
      if (ordered.length > 6) lines.push(c.more(ordered.length - 6));
      lines.push(...weekLines);
      return { text: lines.join("\n"), hasContent: true, reviewKinds: [] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[], weekTasks };
    };

    const evening = () => {
      const decisions = relevant.filter(({ task, occurrence }) => task.importance !== "normal" && ["open", "in_progress", "scheduled"].includes(occurrence.status));
      const normal = relevant.filter(({ task }) => task.importance === "normal");
      if (!decisions.length && !normal.length)
        return {
          text: c.eveningEmpty,
          hasContent: false,
          reviewKinds: [] as Array<"evening" | "weekly">,
          decisionOccurrenceIds: [] as string[],
          weekTasks: [] as Array<{ id: string; title: string }>,
        };
      const lines = [c.evening, `\n${c.left}: ${decisions.length + normal.length}`];
      if (decisions.length) {
        lines.push(`\n${c.decide}`);
        // The importance icon stays: it is exactly what "needs a decision" is about.
        decisions.slice(0, 3).forEach((row, index) => lines.push(`${index + 1}. ${todayLine(row.task, row.occurrence, input.localDate, locale, input.now ?? new Date())}`));
      }
      if (normal.length) {
        lines.push(`\n${c.rest}`);
        for (const row of normal.slice(0, Math.max(0, 5 - decisions.length))) lines.push(todayLine(row.task, row.occurrence, input.localDate, locale, input.now ?? new Date()));
      }
      if (decisions.length + normal.length > 6) lines.push(c.more(decisions.length + normal.length - 6));
      return {
        text: lines.join("\n"),
        hasContent: true,
        reviewKinds: ["evening"] as Array<"evening" | "weekly">,
        decisionOccurrenceIds: decisions.slice(0, 3).map((row) => row.occurrence.id),
        weekTasks: [] as Array<{ id: string; title: string }>,
      };
    };

    /**
     * The weekly delivery is the week plan now: what the past week closed, what was taken and left,
     * and an invitation to pick the coming week. The picking itself is deterministic taps on /week,
     * so this card carries no conversation.
     */
    const weekly = async () => {
      const range = previousWeekRange(input.localDate);
      const [[done], [stale], [pool]] = await Promise.all([
        this.database.db
          .select({ count: sql<number>`count(*)::int` })
          .from(taskOccurrences)
          .where(
            and(
              eq(taskOccurrences.workspaceId, input.workspaceId),
              eq(taskOccurrences.status, "done"),
              sql`(${taskOccurrences.completedAt} AT TIME ZONE ${taskOccurrences.timezone})::date between ${range.start}::date and ${range.end}::date`,
            ),
          ),
        this.database.db
          .select({ count: sql<number>`count(*)::int` })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.status, "active"), eq(tasks.timeMode, "fuzzy"), eq(tasks.pickedWeekStart, range.start))),
        this.database.db
          .select({ count: sql<number>`count(*)::int` })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.status, "active"), eq(tasks.timeMode, "fuzzy"))),
      ]);
      const lines = [c.weeklyPick, "", c.weekSummary(done?.count ?? 0, stale?.count ?? 0), ""];
      lines.push((pool?.count ?? 0) > 0 ? c.weekPlanCta : c.weekPoolEmpty);
      return {
        text: lines.join("\n"),
        hasContent: true,
        reviewKinds: [] as Array<"evening" | "weekly">,
        decisionOccurrenceIds: [] as string[],
        weekTasks: [] as Array<{ id: string; title: string }>,
      };
    };

    if (input.kind === "morning") return bounded(morning());
    if (input.kind === "evening") return bounded(evening());
    if (input.kind === "weekly") return bounded(await weekly());
    const [eveningPart, weeklyPart] = await Promise.all([Promise.resolve(evening()), weekly()]);
    const parts = [eveningPart, weeklyPart].filter((part) => part.hasContent);
    return bounded({
      text: parts.map((part) => part.text).join("\n\n"),
      hasContent: parts.length > 0,
      reviewKinds: parts.flatMap((part) => part.reviewKinds),
      decisionOccurrenceIds: eveningPart.hasContent ? eveningPart.decisionOccurrenceIds : [],
      weekTasks: [] as Array<{ id: string; title: string }>,
    });
  }

  async isCurrentReviewDelivery(input: {
    workspaceId: string;
    userId: string;
    deliveryId: string;
    kind: "evening" | "weekly";
    telegramMessageId: number;
    localDate: string;
  }): Promise<boolean> {
    const [delivery] = await this.database.db
      .select({
        kind: briefingDeliveries.kind,
        status: briefingDeliveries.status,
        localDate: briefingDeliveries.localDate,
        telegramMessageId: briefingDeliveries.telegramMessageId,
      })
      .from(briefingDeliveries)
      .where(and(eq(briefingDeliveries.id, input.deliveryId), eq(briefingDeliveries.workspaceId, input.workspaceId), eq(briefingDeliveries.recipientUserId, input.userId)))
      .limit(1);
    if (!delivery || delivery.status !== "sent" || delivery.localDate !== input.localDate || delivery.telegramMessageId !== input.telegramMessageId) return false;
    return input.kind === "evening" ? ["evening", "evening_weekly"].includes(delivery.kind) : ["weekly", "evening_weekly"].includes(delivery.kind);
  }
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
