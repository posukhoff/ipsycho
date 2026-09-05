import { Injectable } from "@nestjs/common";
import { PeriodicService } from "../runtime/periodic.service.js";
import { InlineKeyboard } from "grammy";
import { MessagesRepository } from "../messages/messages.repository.js";
import { renderChatResult } from "../telegram/telegram-chat-render.js";
import { TelegramService } from "../telegram/telegram.service.js";
import { ChatService } from "./chat.service.js";
import { safeError, safeMessageMetadata } from "../observability/safe-error.js";
import { logger } from "../observability/logger.js";
import { automaticAiRetryLimit } from "../core/ai-retry-policy.js";
import { t } from "../telegram/copy/index.js";
import { telegramLocale } from "../telegram/telegram-locale.js";

const RETRY_TICK_MS = 60_000;

@Injectable()
export class AiRetryService extends PeriodicService {
  protected readonly loopName = "ai_retry";
  protected readonly intervalMs = RETRY_TICK_MS;

  constructor(
    private readonly messages: MessagesRepository,
    private readonly chat: ChatService,
    private readonly telegram: TelegramService,
  ) {
    super();
  }

  protected async runTick(): Promise<void> {
    const due = await this.messages.findDueAiRetries(new Date(), 25);
    for (const row of due) {
      try {
        const result = await this.chat.retryMessage({
          workspaceId: row.message.workspaceId,
          userId: row.message.userId,
          timezone: row.settings.timezone,
          language: row.settings.pinnedLanguage ?? row.settings.telegramLanguage,
          messageId: row.message.id,
        });
        if (result.kind === "consent_required") {
          await this.messages.setStatus(row.message.workspaceId, row.message.id, "blocked_consent");
          continue;
        }
        if (result.kind !== "ok") {
          // `ai_unavailable` leaves the row due, so without a new time it is re-read every tick
          // forever while `aiRetryCount` never grows and the exhaustion notice never fires.
          if (result.kind === "ai_unavailable")
            await this.messages.deferAiUntil(row.message.workspaceId, row.message.userId, row.message.id, new Date(Date.now() + 60 * 60_000)).catch(() => undefined);
          continue;
        }
        const rendered = renderChatResult(result);
        if (result.supersededPendingGroupId) await this.dropCardButtons(row.message.workspaceId, result.supersededPendingGroupId);
        // The bot only serves private chats, where the chat id is the user's Telegram id.
        const telegramChatId = row.user.telegramUserId;
        const telegramMessageId = await this.telegram.sendMessage(telegramChatId, rendered.persistedText, rendered.keyboard);
        if (result.skipAssistantHistory) continue;
        await this.chat.recordAssistantMessage({
          workspaceId: row.message.workspaceId,
          userId: row.message.userId,
          content: rendered.persistedText,
          telegramChatId,
          telegramMessageId,
          ...(result.topicId ? { topicId: result.topicId } : {}),
          ...(result.pendingGroupId ? { pendingGroupId: result.pendingGroupId } : {}),
        });
      } catch (error) {
        logger.error("automatic AI retry failed", { messageId: row.message.id, message: safeMessageMetadata(row.message.content), error: safeError(error) });
        // `aiRetryCount` counts the failures so far, so a row carrying the limit is on its last
        // automatic attempt: the failure just logged sets `aiNextRetryAt` to null and
        // `findDueAiRetries` never selects it again. Without this line the message stays in
        // `waiting_ai` forever and the user, told the bot would try again, waits for nothing.
        if (row.message.aiRetryCount >= automaticAiRetryLimit()) await this.notifyRetriesExhausted(row);
      }
    }
  }

  /** The last automatic attempt failed: name the message that was lost and offer the manual retry. */
  private async notifyRetriesExhausted(row: {
    message: { content: string };
    user: { telegramUserId: number };
    settings: { pinnedLanguage: string | null; telegramLanguage: string | null };
  }): Promise<void> {
    const locale = telegramLocale(row.settings.pinnedLanguage, row.settings.telegramLanguage ?? undefined);
    const preview = row.message.content.trim().replace(/\s+/gu, " ").slice(0, 60);
    await this.telegram.sendMessage(row.user.telegramUserId, t(locale, "ai_retry_exhausted", { preview })).catch(() => undefined);
  }

  /** A replaced confirmation card keeps its text but loses its buttons; the group is already cancelled. */
  private async dropCardButtons(workspaceId: string, groupId: string): Promise<void> {
    const card = await this.chat.findCardMessage(workspaceId, groupId).catch(() => null);
    if (!card?.telegramMessageId) return;
    await this.telegram.bot.api.editMessageReplyMarkup(card.telegramChatId, card.telegramMessageId, { reply_markup: new InlineKeyboard() }).catch(() => undefined);
  }
}
