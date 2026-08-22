import { Injectable } from "@nestjs/common";
import { and, eq, gte, inArray } from "drizzle-orm";
import { localDateAt } from "../core/timezone.js";
import { deadlineUrgency } from "../core/deadline-urgency.js";
import { aggregateHistoricalGoalMovement, habitCompletionStats, WEEKLY_MOVEMENT_EVENT_TYPES, WEEKLY_REVIEW_GOAL_STATUSES } from "../core/weekly-review-policy.js";
import { DatabaseService } from "../database/database.service.js";
import { briefingDeliveries, goals, taskEvents, taskGoals, taskOccurrences, tasks } from "../database/schema.js";

const NONTERMINAL = ["scheduled", "open", "in_progress"] as const;

@Injectable()
export class BriefingContentService {
  constructor(private readonly database: DatabaseService) {}

  async build(input: { workspaceId: string; kind: "morning" | "evening" | "weekly" | "evening_weekly"; localDate: string; timezone: string; now?: Date }) {
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
      if (!ordered.length) return { text: "☀️ Сегодня\n\nЗапланированных дел нет.", hasContent: false, reviewKinds: [] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[] };
      const main = ordered.find(({ task }) => task.importance !== "normal") ?? ordered[0];
      const lines = [`☀️ Сегодня · ${ordered.length} ${taskWord(ordered.length)}`];
      if (main) lines.push(`\nГлавное: ${main.task.title}`);
      lines.push("");
      for (const row of ordered.slice(0, 6)) lines.push(compactTaskLine(row.task, row.occurrence));
      if (ordered.length > 6) lines.push(`+ ещё ${ordered.length - 6}`);
      return { text: lines.join("\n"), hasContent: true, reviewKinds: [] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[] };
    };

    const evening = () => {
      const decisions = relevant.filter(({ task, occurrence }) => task.importance !== "normal" && ["open", "in_progress", "scheduled"].includes(occurrence.status));
      const normal = relevant.filter(({ task }) => task.importance === "normal");
      if (!decisions.length && !normal.length) return { text: "🌙 Вечер\n\nНа сегодня всё закрыто.", hasContent: false, reviewKinds: [] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[] };
      const lines = ["🌙 Вечер", `\nОсталось: ${decisions.length + normal.length}`];
      if (decisions.length) {
        lines.push("\nНужно решить:");
        decisions.slice(0, 3).forEach((row, index) => lines.push(`${index + 1}. ${compactTaskLine(row.task, row.occurrence, false)}`));
      }
      if (normal.length) {
        lines.push("\nОстальное:");
        for (const row of normal.slice(0, Math.max(0, 5 - decisions.length))) lines.push(compactTaskLine(row.task, row.occurrence));
      }
      if (decisions.length + normal.length > 6) lines.push(`+ ещё ${decisions.length + normal.length - 6}`);
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
      if (!activeGoals.length && !habitTasks.length && !recentLinkedMovement.length && !hasPlanningDeadline) return { text: "📅 Недельный обзор\n\nСейчас нет активных целей, привычек или движения для обзора.", hasContent: false, reviewKinds: [] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[] };

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

      const lines = ["📅 Недельный обзор"];
      const goalFacts = activeGoals.slice(0, 8).map((goal) => {
        const goalTaskIds = links.filter((link) => link.goalId === goal.id).map((link) => link.taskId);
        const goalTasks = linkedTasks.filter((task) => goalTaskIds.includes(task.id));
        const activeTasks = goalTasks.filter((task) => task.status === "active");
        const doneCount = recentEvents.filter((event) => goalTaskIds.includes(event.taskId) && event.eventType === "occurrence:done").length;
        const next = activeTasks.find((task) => task.nextAction)?.nextAction ?? activeTasks[0]?.title ?? null;
        const blocked = recentEvents.filter((event) => goalTaskIds.includes(event.taskId) && ["occurrence:rescheduled", "occurrence:cant_start"].includes(event.eventType)).length;
        return { goal, doneCount, activeCount: activeTasks.length, next, blocked, needsHelp: doneCount === 0 || !next };
      });
      if (goalFacts.length) {
        lines.push("\n🎯 Цели");
        for (const fact of goalFacts) lines.push(`• ${fact.goal.title} — выполнений: ${fact.doneCount}; активных задач: ${fact.activeCount}.`);
      }

      const planning = occurrenceRows.map(({ task, occurrence }) => ({ task, occurrence, urgency: deadlineUrgency({
        dueAt: occurrence.dueAt, dueLocalDate: occurrence.dueLocalDate, timezone: occurrence.timezone, now,
      }) })).filter((row) => row.urgency === "watch" || row.urgency === "high" || row.urgency === "urgent" || row.urgency === "overdue")
        .sort((a, b) => urgencyRank(a.urgency!) - urgencyRank(b.urgency!));
      if (planning.length) {
        lines.push("\n🗓 Планирование ближайшей недели");
        for (const row of planning.slice(0, 5)) {
          const label = row.urgency === "urgent" ? "срочно" : row.urgency === "high" ? "на этой неделе" : row.urgency === "watch" ? "скоро" : "просрочено";
          lines.push(`• ${row.task.title} — ${label}${row.task.nextAction ? `; следующий шаг: ${row.task.nextAction}` : ""}${row.task.context ? `; контекст: ${row.task.context}` : ""}.`);
        }
      }

      if (recentLinkedMovement.length) {
        const movement = aggregateHistoricalGoalMovement(
          recentLinkedMovement.map(({ event, goal }) => ({ goalId: goal.id, title: goal.title, eventType: event.eventType })),
          new Set(activeGoals.map((goal) => goal.id)),
        );
        if (movement.length) {
          lines.push("\n📈 Движение по завершённым или приостановленным целям");
          for (const fact of movement.slice(0, 8)) {
            const details = [fact.done ? `выполнено: ${fact.done}` : "", fact.rescheduled ? `перенесено: ${fact.rescheduled}` : ""].filter(Boolean);
            if (details.length) lines.push(`• ${fact.title} — ${details.join(", ")}.`);
          }
        }
      }

      // The proactive part is intentionally global and bounded: one obstacle, one suggestion, one next step.
      const focus = goalFacts.find((fact) => fact.needsHelp);
      if (focus) {
        lines.push("\n💡 Фокус на неделю");
        if (focus.blocked > 0) lines.push(`• У цели «${focus.goal.title}» были повторные переносы или сложности со стартом.`);
        lines.push(`• Следующий шаг: ${focus.next ?? "сформулировать одну небольшую задачу на ближайшую неделю"}.`);
      }

      if (habitTasks.length) {
        const habitIds = habitTasks.map((task) => task.id);
        const recentOccurrences = await this.database.db.select().from(taskOccurrences).where(and(
          eq(taskOccurrences.workspaceId, input.workspaceId),
          inArray(taskOccurrences.taskId, habitIds),
          gte(taskOccurrences.updatedAt, weekCutoff),
        ));
        lines.push("\n🔁 Привычки за последние 7 дней");
        let repeatedMisses = 0;
        for (const task of habitTasks.slice(0, 8)) {
          const stats = habitCompletionStats(recentOccurrences.filter((occurrence) => occurrence.taskId === task.id).map((occurrence) => occurrence.status));
          lines.push(`• ${task.title}: ${stats.rate === null ? "пока мало данных" : `${stats.done}/${stats.total} выполнено (${stats.rate}%)`}.`);
          if (stats.missed >= 2) repeatedMisses += 1;
        }
        if (repeatedMisses) lines.push(`• Повторные пропуски: ${repeatedMisses}. Это только наблюдение для следующего разбора.`);
      }
      return { text: lines.join("\n"), hasContent: true, reviewKinds: ["weekly"] as Array<"evening" | "weekly">, decisionOccurrenceIds: [] as string[] };
    };

    if (input.kind === "morning") return morning();
    if (input.kind === "evening") return evening();
    if (input.kind === "weekly") return weekly();
    const [eveningPart, weeklyPart] = await Promise.all([Promise.resolve(evening()), weekly()]);
    const parts = [eveningPart, weeklyPart].filter((part) => part.hasContent);
    return { text: parts.map((part) => part.text).join("\n\n"), hasContent: parts.length > 0, reviewKinds: parts.flatMap((part) => part.reviewKinds), decisionOccurrenceIds: eveningPart.hasContent ? eveningPart.decisionOccurrenceIds : [] };
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


function compactTaskLine(task: typeof tasks.$inferSelect, occurrence: typeof taskOccurrences.$inferSelect, includeBullet = true): string {
  const icon = task.importance === "critical" ? "🔴" : task.importance === "required" ? "🟡" : task.recurrenceRule ? "🔁" : "•";
  const status = occurrence.overdue ? " · просрочено" : occurrence.status === "in_progress" ? " · в работе" : "";
  return `${includeBullet ? icon : ""}${includeBullet ? " " : ""}${task.title}${status}`;
}

function importanceRank(value: typeof tasks.$inferSelect["importance"]): number {
  return value === "critical" ? 0 : value === "required" ? 1 : 2;
}

function urgencyRank(value: "normal" | "watch" | "high" | "urgent" | "overdue" | null): number {
  return value === "overdue" ? 0 : value === "urgent" ? 1 : value === "high" ? 2 : value === "watch" ? 3 : 4;
}

function taskWord(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return "дел";
  if (mod10 === 1) return "дело";
  if (mod10 >= 2 && mod10 <= 4) return "дела";
  return "дел";
}
