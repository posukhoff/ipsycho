import { Injectable } from "@nestjs/common";
import { and, eq, gte, inArray } from "drizzle-orm";
import { localDateAt } from "../core/timezone.js";
import { deadlineUrgency } from "../core/deadline-urgency.js";
import { selectCardDetails } from "../core/card-details.js";
import { aggregateHistoricalGoalMovement, habitCompletionStats, WEEKLY_MOVEMENT_EVENT_TYPES, WEEKLY_REVIEW_GOAL_STATUSES } from "../core/weekly-review-policy.js";
import { DatabaseService } from "../database/database.service.js";
import { todayLine } from "../telegram/telegram-ui.js";
import type { TelegramLocale } from "../telegram/telegram-locale.js";
import { compactText } from "../core/telegram-ux.js";
import { briefingDeliveries, goals, taskEvents, taskGoals, taskOccurrences, tasks } from "../database/schema.js";

const NONTERMINAL = ["scheduled", "open", "in_progress"] as const;
/** Telegram's hard limit is 4096; a weekly review with many goals and habits must stay under it. */
const BRIEFING_MAX_CHARS = 3_900;

const COPY = {
  ru: {
    morningEmpty: "☀️ Сегодня\n\nЗапланированных дел нет.", morning: "☀️ Сегодня", main: "Главное", more: (n: number) => `+ ещё ${n}`,
    eveningEmpty: "🌙 Вечер\n\nНа сегодня всё закрыто.", evening: "🌙 Вечер", left: "Осталось", decide: "Нужно решить:", rest: "Остальное:",
    weeklyEmpty: "📅 Недельный обзор\n\nСейчас нет активных целей, привычек или движения для обзора.", weekly: "📅 Недельный обзор", goals: "🎯 Цели",
    goalFact: (done: number, active: number) => `выполнений: ${done}; активных задач: ${active}.`, planning: "🗓 Планирование ближайшей недели",
    urgency: { urgent: "срочно", high: "на этой неделе", watch: "скоро", overdue: "просрочено" }, nextStep: "следующий шаг", context: "контекст",
    movement: "📈 Движение по завершённым или приостановленным целям", done: "выполнено", rescheduled: "перенесено", focus: "💡 Фокус на неделю",
    blocked: (goal: string) => `У цели «${goal}» были повторные переносы или сложности со стартом.`, focusStep: "Следующий шаг", defaultStep: "сформулировать одну небольшую задачу на ближайшую неделю",
    habits: "🔁 Привычки за последние 7 дней", fewData: "пока мало данных", habitRate: (done: number, total: number, rate: number) => `${done}/${total} выполнено (${rate}%)`,
    misses: (n: number) => `Повторные пропуски: ${n}. Это только наблюдение для следующего разбора.`,
    tasks: (n: number) => `${n} ${plural(n, "дело", "дела", "дел")}`,
  },
  uk: {
    morningEmpty: "☀️ Сьогодні\n\nЗапланованих справ немає.", morning: "☀️ Сьогодні", main: "Головне", more: (n: number) => `+ ще ${n}`,
    eveningEmpty: "🌙 Вечір\n\nНа сьогодні все закрито.", evening: "🌙 Вечір", left: "Залишилось", decide: "Треба вирішити:", rest: "Решта:",
    weeklyEmpty: "📅 Тижневий огляд\n\nЗараз немає активних цілей, звичок або руху для огляду.", weekly: "📅 Тижневий огляд", goals: "🎯 Цілі",
    goalFact: (done: number, active: number) => `виконань: ${done}; активних завдань: ${active}.`, planning: "🗓 Планування найближчого тижня",
    urgency: { urgent: "терміново", high: "цього тижня", watch: "скоро", overdue: "прострочено" }, nextStep: "наступний крок", context: "контекст",
    movement: "📈 Рух за завершеними або призупиненими цілями", done: "виконано", rescheduled: "перенесено", focus: "💡 Фокус на тиждень",
    blocked: (goal: string) => `У цілі «${goal}» були повторні перенесення або складнощі зі стартом.`, focusStep: "Наступний крок", defaultStep: "сформулювати одне невелике завдання на найближчий тиждень",
    habits: "🔁 Звички за останні 7 днів", fewData: "поки мало даних", habitRate: (done: number, total: number, rate: number) => `${done}/${total} виконано (${rate}%)`,
    misses: (n: number) => `Повторні пропуски: ${n}. Це лише спостереження для наступного розбору.`,
    tasks: (n: number) => `${n} ${plural(n, "справа", "справи", "справ")}`,
  },
  en: {
    morningEmpty: "☀️ Today\n\nNothing is planned.", morning: "☀️ Today", main: "Main", more: (n: number) => `+ ${n} more`,
    eveningEmpty: "🌙 Evening\n\nEverything for today is closed.", evening: "🌙 Evening", left: "Left", decide: "Needs a decision:", rest: "The rest:",
    weeklyEmpty: "📅 Weekly review\n\nNo active goals, habits or movement to review right now.", weekly: "📅 Weekly review", goals: "🎯 Goals",
    goalFact: (done: number, active: number) => `completions: ${done}; active tasks: ${active}.`, planning: "🗓 Planning the coming week",
    urgency: { urgent: "urgent", high: "this week", watch: "soon", overdue: "overdue" }, nextStep: "next step", context: "context",
    movement: "📈 Movement on completed or paused goals", done: "done", rescheduled: "moved", focus: "💡 Focus for the week",
    blocked: (goal: string) => `Goal “${goal}” had repeated moves or trouble getting started.`, focusStep: "Next step", defaultStep: "define one small task for the coming week",
    habits: "🔁 Habits over the last 7 days", fewData: "not enough data yet", habitRate: (done: number, total: number, rate: number) => `${done}/${total} done (${rate}%)`,
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
    const occurrenceRows = await this.database.db.select({ task: tasks, occurrence: taskOccurrences })
      .from(taskOccurrences)
      .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
      .where(and(
        eq(taskOccurrences.workspaceId, input.workspaceId),
        eq(tasks.status, "active"),
        inArray(taskOccurrences.status, [...NONTERMINAL]),
      ));

    const relevant = occurrenceRows.filter(({ task, occurrence }) => {
      if (occurrence.overdue) return true;
      if (occurrence.plannedLocalDate === input.localDate || occurrence.dueLocalDate === input.localDate) return true;
      if (occurrence.plannedStartAt && localDateAt(occurrence.plannedStartAt, occurrence.timezone) === input.localDate) return true;
      if (occurrence.dueAt && localDateAt(occurrence.dueAt, occurrence.timezone) === input.localDate) return true;
      if (task.timeMode === "window" && occurrence.plannedEndAt && localDateAt(occurrence.plannedEndAt, occurrence.timezone) === input.localDate) return true;
      return false;
    });

    const morning = () => {
      const ordered = [...relevant].sort((a, b) => importanceRank(a.task.importance) - importanceRank(b.task.importance));
      if (!ordered.length) return { text: c.morningEmpty, hasContent: false, reviewKinds: [] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[] };
      const main = ordered.find(({ task }) => task.importance !== "normal") ?? ordered[0];
      const lines = [`${c.morning} · ${c.tasks(ordered.length)}`];
      if (main) lines.push(`\n${c.main}: ${main.task.title}`);
      lines.push("");
      for (const row of ordered.slice(0, 6)) lines.push(todayLine(row.task, row.occurrence, input.localDate, locale, input.now ?? new Date()));
      if (ordered.length > 6) lines.push(c.more(ordered.length - 6));
      return { text: lines.join("\n"), hasContent: true, reviewKinds: [] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[] };
    };

    const evening = () => {
      const decisions = relevant.filter(({ task, occurrence }) => task.importance !== "normal" && ["open", "in_progress", "scheduled"].includes(occurrence.status));
      const normal = relevant.filter(({ task }) => task.importance === "normal");
      if (!decisions.length && !normal.length) return { text: c.eveningEmpty, hasContent: false, reviewKinds: [] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[] };
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
      return { text: lines.join("\n"), hasContent: true, reviewKinds: ["evening"] as Array<"evening" | "weekly">, decisionOccurrenceIds: decisions.slice(0, 3).map((row) => row.occurrence.id) };
    };

    const weekly = async () => {
      const now = input.now ?? new Date();
      const weekCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
      const hasPlanningDeadline = occurrenceRows.some(({ occurrence }) => {
        const urgency = deadlineUrgency({ dueAt: occurrence.dueAt, dueLocalDate: occurrence.dueLocalDate, timezone: occurrence.timezone, now });
        return urgency === "watch" || urgency === "high" || urgency === "urgent" || urgency === "overdue";
      });
      const [activeGoals, habitTasks, recentLinkedMovement] = await Promise.all([
        this.database.db.select().from(goals).where(and(eq(goals.workspaceId, input.workspaceId), eq(goals.status, "active"), eq(goals.reviewEnabled, true))),
        this.database.db.select().from(tasks).where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.status, "active"), eq(tasks.habitMode, true))),
        this.database.db.select({ event: taskEvents, goal: goals }).from(taskEvents)
          .innerJoin(taskGoals, and(eq(taskGoals.workspaceId, taskEvents.workspaceId), eq(taskGoals.taskId, taskEvents.taskId)))
          .innerJoin(goals, and(eq(goals.workspaceId, taskGoals.workspaceId), eq(goals.id, taskGoals.goalId)))
          .where(and(
            eq(taskEvents.workspaceId, input.workspaceId),
            eq(goals.reviewEnabled, true),
            inArray(goals.status, [...WEEKLY_REVIEW_GOAL_STATUSES]),
            inArray(taskEvents.eventType, [...WEEKLY_MOVEMENT_EVENT_TYPES]),
            gte(taskEvents.createdAt, weekCutoff),
          )),
      ]);
      if (!activeGoals.length && !habitTasks.length && !recentLinkedMovement.length && !hasPlanningDeadline) return { text: c.weeklyEmpty, hasContent: false, reviewKinds: [] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[] };

      const links = activeGoals.length
        ? await this.database.db.select().from(taskGoals).where(and(eq(taskGoals.workspaceId, input.workspaceId), inArray(taskGoals.goalId, activeGoals.map((goal) => goal.id))))
        : [];
      const linkedTaskIds = [...new Set(links.map((link) => link.taskId))];
      const linkedTasks = linkedTaskIds.length
        ? await this.database.db.select().from(tasks).where(and(eq(tasks.workspaceId, input.workspaceId), inArray(tasks.id, linkedTaskIds)))
        : [];
      const recentEvents = linkedTaskIds.length
        ? await this.database.db.select().from(taskEvents).where(and(
            eq(taskEvents.workspaceId, input.workspaceId),
            inArray(taskEvents.taskId, linkedTaskIds),
            gte(taskEvents.createdAt, weekCutoff),
          ))
        : [];

      const lines: string[] = [c.weekly];
      const goalFacts = activeGoals.slice(0, 8).map((goal) => {
        const goalTaskIds = links.filter((link) => link.goalId === goal.id).map((link) => link.taskId);
        const goalTasks = linkedTasks.filter((task) => goalTaskIds.includes(task.id));
        const activeTasks = goalTasks.filter((task) => task.status === "active");
        const doneCount = recentEvents.filter((event) => goalTaskIds.includes(event.taskId) && event.eventType === "occurrence:done").length;
        const next = activeTasks.map((task) => selectCardDetails(task).nextAction).find(Boolean) ?? activeTasks[0]?.title ?? null;
        const blocked = recentEvents.filter((event) => goalTaskIds.includes(event.taskId) && ["occurrence:rescheduled", "occurrence:cant_start"].includes(event.eventType)).length;
        return { goal, doneCount, activeCount: activeTasks.length, next, blocked, needsHelp: doneCount === 0 || !next };
      });
      if (goalFacts.length) {
        lines.push(`\n${c.goals}`);
        for (const fact of goalFacts) lines.push(`• ${fact.goal.title} — ${c.goalFact(fact.doneCount, fact.activeCount)}`);
      }

      const planning = occurrenceRows.map(({ task, occurrence }) => ({ task, occurrence, urgency: deadlineUrgency({
        dueAt: occurrence.dueAt, dueLocalDate: occurrence.dueLocalDate, timezone: occurrence.timezone, now,
      }) })).filter((row) => row.urgency === "watch" || row.urgency === "high" || row.urgency === "urgent" || row.urgency === "overdue")
        .sort((a, b) => urgencyRank(a.urgency!) - urgencyRank(b.urgency!));
      if (planning.length) {
        lines.push(`\n${c.planning}`);
        for (const row of planning.slice(0, 5)) {
          const label = row.urgency === "urgent" ? c.urgency.urgent : row.urgency === "high" ? c.urgency.high : row.urgency === "watch" ? c.urgency.watch : c.urgency.overdue;
          const details = selectCardDetails(row.task);
          lines.push(`• ${row.task.title} — ${label}${details.nextAction ? `; ${c.nextStep}: ${compactText(details.nextAction, 120)}` : ""}${details.context ? `; ${c.context}: ${compactText(details.context, 120)}` : ""}.`);
        }
      }

      if (recentLinkedMovement.length) {
        const movement = aggregateHistoricalGoalMovement(
          recentLinkedMovement.map(({ event, goal }) => ({ goalId: goal.id, title: goal.title, eventType: event.eventType })),
          new Set(activeGoals.map((goal) => goal.id)),
        );
        if (movement.length) {
          lines.push(`\n${c.movement}`);
          for (const fact of movement.slice(0, 8)) {
            const details = [fact.done ? `${c.done}: ${fact.done}` : "", fact.rescheduled ? `${c.rescheduled}: ${fact.rescheduled}` : ""].filter(Boolean);
            if (details.length) lines.push(`• ${fact.title} — ${details.join(", ")}.`);
          }
        }
      }

      // The proactive part is intentionally global and bounded: one obstacle, one suggestion, one next step.
      const focus = goalFacts.find((fact) => fact.needsHelp);
      if (focus) {
        lines.push(`\n${c.focus}`);
        if (focus.blocked > 0) lines.push(`• ${c.blocked(focus.goal.title)}`);
        lines.push(`• ${c.focusStep}: ${focus.next ?? c.defaultStep}.`);
      }

      if (habitTasks.length) {
        const habitIds = habitTasks.map((task) => task.id);
        const recentOccurrences = await this.database.db.select().from(taskOccurrences).where(and(
          eq(taskOccurrences.workspaceId, input.workspaceId),
          inArray(taskOccurrences.taskId, habitIds),
          gte(taskOccurrences.updatedAt, weekCutoff),
        ));
        lines.push(`\n${c.habits}`);
        let repeatedMisses = 0;
        for (const task of habitTasks.slice(0, 8)) {
          const stats = habitCompletionStats(recentOccurrences.filter((occurrence) => occurrence.taskId === task.id).map((occurrence) => occurrence.status));
          lines.push(`• ${task.title}: ${stats.rate === null ? c.fewData : c.habitRate(stats.done, stats.total, stats.rate)}.`);
          if (stats.missed >= 2) repeatedMisses += 1;
        }
        if (repeatedMisses) lines.push(`• ${c.misses(repeatedMisses)}`);
      }
      return { text: lines.join("\n"), hasContent: true, reviewKinds: ["weekly"] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[] };
    };

    if (input.kind === "morning") return bounded(morning());
    if (input.kind === "evening") return bounded(evening());
    if (input.kind === "weekly") return bounded(await weekly());
    const [eveningPart, weeklyPart] = await Promise.all([Promise.resolve(evening()), weekly()]);
    const parts = [eveningPart, weeklyPart].filter((part) => part.hasContent);
    return bounded({ text: parts.map((part) => part.text).join("\n\n"), hasContent: parts.length > 0, reviewKinds: parts.flatMap((part) => part.reviewKinds), decisionOccurrenceIds: eveningPart.hasContent ? eveningPart.decisionOccurrenceIds : [] });
  }

  async isCurrentReviewDelivery(input: {
    workspaceId: string;
    userId: string;
    deliveryId: string;
    kind: "evening" | "weekly";
    telegramMessageId: number;
    localDate: string;
  }): Promise<boolean> {
    const [delivery] = await this.database.db.select({
      kind: briefingDeliveries.kind,
      status: briefingDeliveries.status,
      localDate: briefingDeliveries.localDate,
      telegramMessageId: briefingDeliveries.telegramMessageId,
    }).from(briefingDeliveries).where(and(
      eq(briefingDeliveries.id, input.deliveryId),
      eq(briefingDeliveries.workspaceId, input.workspaceId),
      eq(briefingDeliveries.recipientUserId, input.userId),
    )).limit(1);
    if (!delivery || delivery.status !== "sent" || delivery.localDate !== input.localDate || delivery.telegramMessageId !== input.telegramMessageId) return false;
    return input.kind === "evening"
      ? ["evening", "evening_weekly"].includes(delivery.kind)
      : ["weekly", "evening_weekly"].includes(delivery.kind);
  }
}


function importanceRank(value: typeof tasks.$inferSelect["importance"]): number {
  return value === "critical" ? 0 : value === "required" ? 1 : 2;
}

function urgencyRank(value: "normal" | "watch" | "high" | "urgent" | "overdue" | null): number {
  return value === "overdue" ? 0 : value === "urgent" ? 1 : value === "high" ? 2 : value === "watch" ? 3 : 4;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
