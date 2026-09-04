import { Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { CLEANUP_BATCH, drainInBatches } from "../database/batched.js";
import { DatabaseService } from "../database/database.service.js";
import { nextAutomaticAiRetryAt } from "../core/ai-retry-policy.js";
import { messages, userSettings, users } from "../database/schema.js";

export type MessageProcessingStatus = "processing" | "processed" | "waiting_ai" | "blocked_consent";

export interface MessageCardRef {
  id: string;
  telegramChatId: number | null;
  telegramMessageId: number | null;
  pendingGroupId: string | null;
  createdAt: Date;
}

const cardRefColumns = {
  id: messages.id,
  telegramChatId: messages.telegramChatId,
  telegramMessageId: messages.telegramMessageId,
  pendingGroupId: messages.pendingGroupId,
  createdAt: messages.createdAt,
};

@Injectable()
export class MessagesRepository {
  constructor(private readonly database: DatabaseService) {}

  async save(input: {
    workspaceId: string;
    userId: string;
    role: "user" | "assistant";
    status?: MessageProcessingStatus;
    topicId?: string;
    content: string;
    telegramChatId?: number;
    telegramMessageId?: number;
    pendingGroupId?: string;
  }) {
    return (await this.saveOnce(input)).message;
  }

  async saveOnce(input: {
    workspaceId: string;
    userId: string;
    role: "user" | "assistant";
    status?: MessageProcessingStatus;
    topicId?: string;
    content: string;
    telegramChatId?: number;
    telegramMessageId?: number;
    pendingGroupId?: string;
  }): Promise<{ message: typeof messages.$inferSelect | null; inserted: boolean }> {
    const [row] = await this.database.db
      .insert(messages)
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role,
        status: input.status ?? "processed",
        ...(input.topicId ? { topicId: input.topicId } : {}),
        content: input.content,
        ...(input.telegramChatId !== undefined ? { telegramChatId: input.telegramChatId } : {}),
        ...(input.telegramMessageId !== undefined ? { telegramMessageId: input.telegramMessageId } : {}),
        ...(input.pendingGroupId ? { pendingGroupId: input.pendingGroupId } : {}),
      })
      .onConflictDoNothing()
      .returning();
    if (row) return { message: row, inserted: true };
    if (input.telegramMessageId === undefined || input.telegramChatId === undefined) return { message: null, inserted: false };
    const [existing] = await this.database.db
      .select()
      .from(messages)
      .where(and(eq(messages.workspaceId, input.workspaceId), eq(messages.telegramChatId, input.telegramChatId), eq(messages.telegramMessageId, input.telegramMessageId)))
      .limit(1);
    return { message: existing ?? null, inserted: false };
  }

  /** The newest assistant turn: the only message a bare "да"/"нет" can answer. */
  async findLastAssistantMessage(workspaceId: string, userId: string): Promise<MessageCardRef | null> {
    const [row] = await this.database.db
      .select(cardRefColumns)
      .from(messages)
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.userId, userId), eq(messages.role, "assistant")))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** The assistant message that carries a given proposal card, to retire its keyboard when superseded. */
  async findByPendingGroup(workspaceId: string, groupId: string): Promise<MessageCardRef | null> {
    const [row] = await this.database.db
      .select(cardRefColumns)
      .from(messages)
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.pendingGroupId, groupId)))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return row ?? null;
  }

  async setStatus(workspaceId: string, messageId: string, status: MessageProcessingStatus): Promise<void> {
    await this.database.db
      .update(messages)
      .set({
        status,
        ...(status === "processed" ? { aiNextRetryAt: null } : {}),
      })
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, messageId)));
  }

  async deferAiUntil(workspaceId: string, userId: string, messageId: string, until: Date): Promise<void> {
    await this.database.db
      .update(messages)
      .set({ status: "waiting_ai", aiNextRetryAt: until })
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.userId, userId), eq(messages.id, messageId)));
  }

  async scheduleAiRetry(workspaceId: string, userId: string, messageId: string, now = new Date()): Promise<{ retryCount: number; nextRetryAt: Date | null }> {
    const [current] = await this.database.db
      .select({ retryCount: messages.aiRetryCount })
      .from(messages)
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.userId, userId), eq(messages.id, messageId)))
      .limit(1);
    const retryCount = (current?.retryCount ?? 0) + 1;
    const nextRetryAt = nextAutomaticAiRetryAt(retryCount, now);
    await this.database.db
      .update(messages)
      .set({
        status: "waiting_ai",
        aiRetryCount: retryCount,
        aiNextRetryAt: nextRetryAt,
        aiLastErrorAt: now,
      })
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.userId, userId), eq(messages.id, messageId)));
    return { retryCount, nextRetryAt };
  }

  async findDueAiRetries(now = new Date(), limit = 25) {
    return this.database.db
      .select({ message: messages, user: users, settings: userSettings })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.userId))
      .innerJoin(userSettings, eq(userSettings.userId, messages.userId))
      .where(and(eq(messages.role, "user"), eq(messages.status, "waiting_ai"), lte(messages.aiNextRetryAt, now), eq(users.status, "active"), eq(users.aiStatus, "enabled")))
      .orderBy(messages.aiNextRetryAt)
      .limit(limit);
  }

  async isAiProcessingAllowed(userId: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.status, "active"), eq(users.aiStatus, "enabled")))
      .limit(1);
    return Boolean(row);
  }

  async countUserMessagesSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.role, "user"), gte(messages.createdAt, since)));
    return row?.count ?? 0;
  }

  async countConversation(workspaceId: string, userId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.userId, userId)));
    return row?.count ?? 0;
  }

  async findLatestRetryable(workspaceId: string, userId: string) {
    const [row] = await this.database.db
      .select()
      .from(messages)
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.userId, userId), eq(messages.role, "user"), inArray(messages.status, ["waiting_ai", "blocked_consent"])))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return row ?? null;
  }

  async claimRetryable(workspaceId: string, userId: string, messageId: string) {
    const [row] = await this.database.db
      .update(messages)
      .set({ status: "processing", aiNextRetryAt: null })
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.userId, userId), eq(messages.id, messageId), inArray(messages.status, ["waiting_ai", "blocked_consent"])))
      .returning();
    return row ?? null;
  }

  async deleteRawOlderThan(cutoff: Date, batchSize = CLEANUP_BATCH): Promise<number> {
    return drainInBatches(batchSize, async () => {
      const batch = this.database.db
        .select({ id: messages.id })
        .from(messages)
        .where(and(lt(messages.createdAt, cutoff), inArray(messages.status, ["processed", "waiting_ai", "blocked_consent", "processing"])))
        .limit(batchSize);
      const result = await this.database.db.delete(messages).where(inArray(messages.id, batch));
      return result.rowCount ?? 0;
    });
  }

  /** Clears conversational memory only; tasks, goals, deliveries and Telegram messages remain intact. */
  async clearConversation(workspaceId: string, userId: string): Promise<number> {
    const deleted = await this.database.db
      .delete(messages)
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.userId, userId)))
      .returning({ id: messages.id });
    return deleted.length;
  }

  /**
   * The last `limit` processed messages by time, whatever topic they were filed under. History
   * was once partitioned by topic, and the model's own `topic.mode: none` on a plain command
   * then hid every previous turn from it.
   */
  async listRecentForAi(workspaceId: string, userId: string, limit = 20) {
    const rows = await this.database.db
      .select()
      .from(messages)
      .where(and(eq(messages.workspaceId, workspaceId), eq(messages.userId, userId), eq(messages.status, "processed")))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return rows.reverse();
  }
}
