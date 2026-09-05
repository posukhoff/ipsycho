import { Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import { tsQueryFor } from "../core/search-query.js";
import { CLEANUP_BATCH, drainInBatches } from "../database/batched.js";
import { DatabaseService } from "../database/database.service.js";
import { conversationTopics, goals, memoryItems, messages, taskGoals, tasks } from "../database/schema.js";

@Injectable()
export class ContextRepository {
  constructor(private readonly database: DatabaseService) {}

  async listTopics(workspaceId: string, userId: string, limit = 6) {
    return this.database.db
      .select()
      .from(conversationTopics)
      .where(and(eq(conversationTopics.workspaceId, workspaceId), eq(conversationTopics.userId, userId), inArray(conversationTopics.status, ["active", "paused"])))
      .orderBy(desc(conversationTopics.lastMessageAt))
      .limit(limit);
  }

  async pauseActiveTopics(workspaceId: string, userId: string, now: Date): Promise<number> {
    const rows = await this.database.db
      .update(conversationTopics)
      .set({
        status: "paused",
        updatedAt: now,
      })
      .where(and(eq(conversationTopics.workspaceId, workspaceId), eq(conversationTopics.userId, userId), eq(conversationTopics.status, "active")))
      .returning({ id: conversationTopics.id });
    return rows.length;
  }

  /** The one topic the model's `continue`/`resolve` directives address; null when none is active. */
  async findActiveTopic(workspaceId: string, userId: string) {
    const [row] = await this.database.db
      .select()
      .from(conversationTopics)
      .where(and(eq(conversationTopics.workspaceId, workspaceId), eq(conversationTopics.userId, userId), eq(conversationTopics.status, "active")))
      .orderBy(desc(conversationTopics.lastMessageAt))
      .limit(1);
    return row ?? null;
  }

  async findTopic(workspaceId: string, userId: string, topicId: string) {
    const [row] = await this.database.db
      .select()
      .from(conversationTopics)
      .where(and(eq(conversationTopics.workspaceId, workspaceId), eq(conversationTopics.userId, userId), eq(conversationTopics.id, topicId)))
      .limit(1);
    return row ?? null;
  }

  async resolveTopic(workspaceId: string, userId: string, topicId: string, now: Date): Promise<boolean> {
    const [row] = await this.database.db
      .update(conversationTopics)
      .set({
        status: "resolved",
        clarificationCount: 0,
        updatedAt: now,
        lastMessageAt: now,
      })
      .where(
        and(
          eq(conversationTopics.workspaceId, workspaceId),
          eq(conversationTopics.userId, userId),
          eq(conversationTopics.id, topicId),
          inArray(conversationTopics.status, ["active", "paused"]),
        ),
      )
      .returning({ id: conversationTopics.id });
    return Boolean(row);
  }

  async createTopic(input: {
    workspaceId: string;
    userId: string;
    title: string;
    summary: string;
    mode: "normal" | "analysis";
    reviewKind?: "evening" | "weekly";
    reviewState?: unknown;
    now: Date;
    summaryExpiresAt: Date;
  }) {
    return this.database.db.transaction(async (tx) => {
      await tx
        .update(conversationTopics)
        .set({ status: "paused", updatedAt: input.now })
        .where(and(eq(conversationTopics.workspaceId, input.workspaceId), eq(conversationTopics.userId, input.userId), eq(conversationTopics.status, "active")));
      const [row] = await tx
        .insert(conversationTopics)
        .values({
          workspaceId: input.workspaceId,
          userId: input.userId,
          title: input.title,
          summary: input.summary,
          status: "active",
          mode: input.mode,
          ...(input.reviewKind ? { reviewKind: input.reviewKind } : {}),
          ...(input.reviewState !== undefined ? { reviewState: input.reviewState } : {}),
          lastMessageAt: input.now,
          summaryExpiresAt: input.summaryExpiresAt,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (!row) throw new Error("failed to create conversation topic");
      return row;
    });
  }

  async updateReviewState(input: { workspaceId: string; userId: string; topicId: string; reviewState: unknown; now: Date }) {
    const [row] = await this.database.db
      .update(conversationTopics)
      .set({ reviewState: input.reviewState, updatedAt: input.now })
      .where(
        and(
          eq(conversationTopics.workspaceId, input.workspaceId),
          eq(conversationTopics.userId, input.userId),
          eq(conversationTopics.id, input.topicId),
          eq(conversationTopics.reviewKind, "weekly"),
          inArray(conversationTopics.status, ["active", "paused"]),
        ),
      )
      .returning();
    return row ?? null;
  }

  async updateTopic(input: {
    workspaceId: string;
    userId: string;
    topicId: string;
    summary: string;
    title?: string;
    status?: "active" | "paused" | "resolved" | "abandoned";
    mode?: "normal" | "analysis";
    now: Date;
    summaryExpiresAt: Date;
  }) {
    return this.database.db.transaction(async (tx) => {
      if (input.status === "active") {
        await tx
          .update(conversationTopics)
          .set({ status: "paused", updatedAt: input.now })
          .where(
            and(
              eq(conversationTopics.workspaceId, input.workspaceId),
              eq(conversationTopics.userId, input.userId),
              eq(conversationTopics.status, "active"),
              ne(conversationTopics.id, input.topicId),
            ),
          );
      }
      const [row] = await tx
        .update(conversationTopics)
        .set({
          summary: input.summary,
          ...(input.title ? { title: input.title } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
          lastMessageAt: input.now,
          summaryExpiresAt: input.summaryExpiresAt,
          updatedAt: input.now,
        })
        .where(and(eq(conversationTopics.workspaceId, input.workspaceId), eq(conversationTopics.userId, input.userId), eq(conversationTopics.id, input.topicId)))
        .returning();
      return row ?? null;
    });
  }

  async updateClarificationCount(input: { workspaceId: string; userId: string; topicId: string; askedQuestion: boolean; now: Date }): Promise<number> {
    return this.database.db.transaction(async (tx) => {
      const [topic] = await tx
        .select({ count: conversationTopics.clarificationCount, status: conversationTopics.status })
        .from(conversationTopics)
        .where(and(eq(conversationTopics.workspaceId, input.workspaceId), eq(conversationTopics.userId, input.userId), eq(conversationTopics.id, input.topicId)))
        .for("update")
        .limit(1);
      if (!topic) return 0;
      const count = topic.status === "resolved" || topic.status === "abandoned" || !input.askedQuestion ? 0 : topic.count + 1;
      await tx
        .update(conversationTopics)
        .set({ clarificationCount: count, updatedAt: input.now })
        .where(and(eq(conversationTopics.workspaceId, input.workspaceId), eq(conversationTopics.userId, input.userId), eq(conversationTopics.id, input.topicId)));
      return count;
    });
  }

  async resetClarificationCount(workspaceId: string, userId: string, topicId: string, now: Date): Promise<void> {
    await this.database.db
      .update(conversationTopics)
      .set({ clarificationCount: 0, updatedAt: now })
      .where(and(eq(conversationTopics.workspaceId, workspaceId), eq(conversationTopics.userId, userId), eq(conversationTopics.id, topicId)));
  }

  async scrubExpiredTopicSummaries(now: Date, batchSize = CLEANUP_BATCH): Promise<number> {
    return drainInBatches(batchSize, async () => {
      const batch = this.database.db
        .select({ id: conversationTopics.id })
        .from(conversationTopics)
        .where(and(lte(conversationTopics.summaryExpiresAt, now), or(ne(conversationTopics.title, ""), ne(conversationTopics.summary, ""))))
        .limit(batchSize);
      const result = await this.database.db
        .update(conversationTopics)
        .set({ title: "", summary: "", status: "abandoned", mode: "normal", updatedAt: now })
        .where(inArray(conversationTopics.id, batch));
      return result.rowCount ?? 0;
    });
  }

  async setMessageTopic(workspaceId: string, messageId: string, topicId: string | null): Promise<void> {
    await this.database.db
      .update(messages)
      .set({ topicId })
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, messageId)));
  }

  /** Expression identical to `memory_items_content_fts_idx` (migration 0006). */
  async searchMemory(workspaceId: string, userId: string, query: string, limit = 5) {
    const tsQuery = tsQueryFor(query);
    if (!tsQuery) return [];
    const vector = sql`to_tsvector('simple', ${memoryItems.content})`;
    const searchQuery = sql`to_tsquery('simple', ${tsQuery})`;
    return this.database.db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.workspaceId, workspaceId), eq(memoryItems.userId, userId), sql`${vector} @@ ${searchQuery}`))
      .orderBy(desc(sql`ts_rank_cd(${vector}, ${searchQuery})`), desc(memoryItems.updatedAt))
      .limit(limit);
  }

  /** Profile facts are intentionally always available to the assistant, unlike search-only memory. */
  async listProfile(workspaceId: string, userId: string, limit = 30) {
    return this.database.db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.workspaceId, workspaceId), eq(memoryItems.userId, userId), eq(memoryItems.type, "context")))
      .orderBy(desc(memoryItems.updatedAt))
      .limit(limit);
  }

  async findMemory(workspaceId: string, userId: string, memoryId: string) {
    const [row] = await this.database.db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.workspaceId, workspaceId), eq(memoryItems.userId, userId), eq(memoryItems.id, memoryId)))
      .limit(1);
    return row ?? null;
  }

  /** Goal rows the model may reference this turn; links come from `listTaskGoalLinks` for the shown tasks. */
  async listGoalsForContext(workspaceId: string, limit = 30) {
    return this.database.db
      .select()
      .from(goals)
      .where(and(eq(goals.workspaceId, workspaceId), inArray(goals.status, ["active", "paused", "completed"])))
      .orderBy(desc(goals.updatedAt))
      .limit(limit);
  }

  /** Goals with their active linked tasks, used by the read-only Telegram overview. */
  async listGoalsWithTasks(workspaceId: string, limit = 30) {
    const goalRows = await this.database.db
      .select()
      .from(goals)
      .where(and(eq(goals.workspaceId, workspaceId), inArray(goals.status, ["active", "paused", "completed"])))
      .orderBy(desc(goals.updatedAt))
      .limit(limit);
    if (!goalRows.length) return [];
    const taskRows = await this.database.db
      .select({ goalId: taskGoals.goalId, task: tasks })
      .from(taskGoals)
      .innerJoin(tasks, and(eq(tasks.workspaceId, taskGoals.workspaceId), eq(tasks.id, taskGoals.taskId)))
      .where(
        and(
          eq(taskGoals.workspaceId, workspaceId),
          inArray(
            taskGoals.goalId,
            goalRows.map((goal) => goal.id),
          ),
          eq(tasks.status, "active"),
        ),
      )
      .orderBy(desc(tasks.updatedAt));
    const tasksByGoal = new Map<string, (typeof taskRows)[number]["task"][]>();
    for (const row of taskRows) {
      const list = tasksByGoal.get(row.goalId) ?? [];
      list.push(row.task);
      tasksByGoal.set(row.goalId, list);
    }
    return goalRows.map((goal) => ({ goal, tasks: tasksByGoal.get(goal.id) ?? [] }));
  }

  async findGoal(workspaceId: string, goalId: string) {
    const [row] = await this.database.db
      .select()
      .from(goals)
      .where(and(eq(goals.workspaceId, workspaceId), eq(goals.id, goalId)))
      .limit(1);
    return row ?? null;
  }

  async findTaskGoalLink(workspaceId: string, taskId: string, goalId: string) {
    const [row] = await this.database.db
      .select()
      .from(taskGoals)
      .where(and(eq(taskGoals.workspaceId, workspaceId), eq(taskGoals.taskId, taskId), eq(taskGoals.goalId, goalId)))
      .limit(1);
    return row ?? null;
  }

  async listTaskGoalLinks(workspaceId: string, taskIds: readonly string[]) {
    if (!taskIds.length) return [];
    return this.database.db
      .select()
      .from(taskGoals)
      .where(and(eq(taskGoals.workspaceId, workspaceId), inArray(taskGoals.taskId, [...taskIds])));
  }
}
