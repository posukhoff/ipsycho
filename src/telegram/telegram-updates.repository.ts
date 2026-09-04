import { Injectable } from "@nestjs/common";
import { and, eq, lt } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { telegramUpdates } from "../database/schema.js";

/**
 * The idempotency ledger for incoming Telegram updates. Telegram redelivers an update it did not
 * see acknowledged, so the same update can arrive twice; the primary key on
 * (bot_identity, telegram_update_id) is what makes the second arrival a no-op.
 */
@Injectable()
export class TelegramUpdatesRepository {
  constructor(private readonly database: DatabaseService) {}

  /** True when this process is the one that claimed the update; false when it is a redelivery. */
  async claim(input: { botIdentity: string; updateId: number; chatId?: number | undefined; messageId?: number | undefined }): Promise<boolean> {
    const inserted = await this.database.db
      .insert(telegramUpdates)
      .values({
        botIdentity: input.botIdentity,
        telegramUpdateId: input.updateId,
        chatId: input.chatId,
        telegramMessageId: input.messageId,
      })
      .onConflictDoNothing()
      .returning({ updateId: telegramUpdates.telegramUpdateId });
    return inserted.length > 0;
  }

  async markHandled(botIdentity: string, updateId: number): Promise<void> {
    await this.database.db
      .update(telegramUpdates)
      .set({ status: "handled" })
      .where(and(eq(telegramUpdates.botIdentity, botIdentity), eq(telegramUpdates.telegramUpdateId, updateId)));
  }

  /** Updates a previous process accepted but never finished; they are recorded, never replayed. */
  async markLost(botIdentity: string, olderThan: Date): Promise<number> {
    const result = await this.database.db
      .update(telegramUpdates)
      .set({ status: "lost" })
      .where(and(eq(telegramUpdates.botIdentity, botIdentity), eq(telegramUpdates.status, "received"), lt(telegramUpdates.createdAt, olderThan)));
    return result.rowCount ?? 0;
  }
}
