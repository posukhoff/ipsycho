import { Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { occurrenceFallsOnLocalDate } from "../core/local-schedule.js";
import { importanceRank } from "../core/types.js";
import { DatabaseService } from "../database/database.service.js";
import { todayLine } from "../telegram/telegram-ui.js";
import type { TelegramLocale } from "../telegram/telegram-locale.js";
import { compactText } from "../core/telegram-ux.js";
import { plural, t } from "../telegram/copy/index.js";
import { targetWeekStart, previousWeekRange } from "../core/week-plan.js";
import { taskOccurrences, tasks } from "../database/schema.js";

const NONTERMINAL = ["scheduled", "open", "in_progress"] as const;
/** Telegram's hard limit is 4096; a card with a long day and a full week pool must stay under it. */
const BRIEFING_MAX_CHARS = 3_900;

@Injectable()
export class BriefingContentService {
  constructor(private readonly database: DatabaseService) {}

  async build(input: { workspaceId: string; kind: "morning" | "weekly"; localDate: string; timezone: string; now?: Date; locale?: TelegramLocale }) {
    const locale: TelegramLocale = input.locale ?? "ru";
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
      .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.status, "active"), eq(tasks.timeMode, "fuzzy"), eq(tasks.pickedWeekStart, targetWeekStart(input.localDate))))
      .orderBy(tasks.updatedAt);

    const morning = () => {
      const ordered = [...relevant].sort((a, b) => importanceRank(a.task.importance) - importanceRank(b.task.importance));
      const weekLines = pickedForWeek.length ? ["", t(locale, "briefing_taken_week"), ...pickedForWeek.slice(0, 8).map((task) => `▸ ${task.title}`)] : [];
      const weekTasks = pickedForWeek.slice(0, 8).map((task) => ({ id: task.id, title: task.title }));
      if (!ordered.length) {
        if (!weekLines.length) return { text: `${t(locale, "briefing_morning_title")}\n\n${t(locale, "nothing_planned")}`, hasContent: false, weekTasks };
        return { text: [t(locale, "briefing_morning_title"), ...weekLines].join("\n"), hasContent: true, weekTasks };
      }
      const main = ordered.find(({ task }) => task.importance !== "normal") ?? ordered[0];
      const lines = [`${t(locale, "briefing_morning_title")} · ${plural(locale, ordered.length, "deed")}`];
      if (main) lines.push(`\n${t(locale, "label_main")}: ${main.task.title}`);
      lines.push("");
      for (const row of ordered.slice(0, 6)) lines.push(todayLine(row.task, row.occurrence, input.localDate, locale, input.now ?? new Date()));
      if (ordered.length > 6) lines.push(t(locale, "list_more", { count: ordered.length - 6 }));
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
      const lines = [t(locale, "briefing_weekly_title"), "", t(locale, "week_plan_summary", { done: done?.count ?? 0, stale: stale?.count ?? 0 }), ""];
      lines.push((pool?.count ?? 0) > 0 ? t(locale, "briefing_week_cta") : t(locale, "briefing_pool_empty"));
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
