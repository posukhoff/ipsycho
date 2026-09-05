import { Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { occurrenceFallsOnLocalDate } from "../core/local-schedule.js";
import { importanceRank } from "../core/types.js";
import { DatabaseService } from "../database/database.service.js";
import { todayLine } from "../telegram/telegram-ui.js";
import type { TelegramLocale } from "../telegram/telegram-locale.js";
import { compactText } from "../core/telegram-ux.js";
import { currentWeekStart, previousWeekRange } from "../core/week-plan.js";
import { taskOccurrences, tasks } from "../database/schema.js";

const NONTERMINAL = ["scheduled", "open", "in_progress"] as const;
/** Telegram's hard limit is 4096; a card with a long day and a full week pool must stay under it. */
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
    tasks: (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`,
  },
} as const;

@Injectable()
export class BriefingContentService {
  constructor(private readonly database: DatabaseService) {}

  async build(input: { workspaceId: string; kind: "morning" | "weekly"; localDate: string; timezone: string; now?: Date; locale?: TelegramLocale }) {
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
        if (!weekLines.length) return { text: c.morningEmpty, hasContent: false, weekTasks };
        return { text: [c.morning, ...weekLines].join("\n"), hasContent: true, weekTasks };
      }
      const main = ordered.find(({ task }) => task.importance !== "normal") ?? ordered[0];
      const lines = [`${c.morning} · ${c.tasks(ordered.length)}`];
      if (main) lines.push(`\n${c.main}: ${main.task.title}`);
      lines.push("");
      for (const row of ordered.slice(0, 6)) lines.push(todayLine(row.task, row.occurrence, input.localDate, locale, input.now ?? new Date()));
      if (ordered.length > 6) lines.push(c.more(ordered.length - 6));
      lines.push(...weekLines);
      return { text: lines.join("\n"), hasContent: true, weekTasks };
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

    return input.kind === "morning" ? bounded(morning()) : bounded(await weekly());
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
