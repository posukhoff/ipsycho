import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { InlineKeyboard } from "grammy";
import { MessagesRepository } from "../messages/messages.repository.js";
import { renderChatResult } from "../telegram/telegram-chat-render.js";
import { TelegramService } from "../telegram/telegram.service.js";
import { ChatService } from "./chat.service.js";
import { safeError, safeMessageMetadata } from "../observability/safe-error.js";

const RETRY_TICK_MS = 60_000;

@Injectable()
export class AiRetryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly messages: MessagesRepository,
    private readonly chat: ChatService,
    private readonly telegram: TelegramService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick().catch((error) => console.error("automatic AI retry tick failed", safeError(error))), RETRY_TICK_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void { if (this.timer) clearInterval(this.timer); }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.messages.findDueAiRetries(new Date(), 25);
      for (const row of due) {
        try {
          const result = await this.chat.retryMessage({
            workspaceId: row.message.workspaceId,
            userId: row.message.userId,
            timezone: row.settings.timezone,
            language: row.settings.pinnedLanguage,
            messageId: row.message.id,
          });
          if (result.kind === "consent_required") {
            await this.messages.setStatus(row.message.workspaceId, row.message.id, "blocked_consent");
            continue;
          }
          if (result.kind !== "ok") continue;
          const rendered = renderChatResult(result);
          if (result.supersededPendingGroupId) await this.dropCardButtons(row.message.workspaceId, result.supersededPendingGroupId);
          // The bot only serves private chats, where the chat id is the user's Telegram id.
          const telegramChatId = row.user.telegramUserId;
          const telegramMessageId = await this.telegram.sendMessage(telegramChatId, rendered.responseText, rendered.keyboard);
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
          console.error("automatic AI retry failed", { messageId: row.message.id, message: safeMessageMetadata(row.message.content), error: safeError(error) });
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** A replaced confirmation card keeps its text but loses its buttons; the group is already cancelled. */
  private async dropCardButtons(workspaceId: string, groupId: string): Promise<void> {
    const card = await this.chat.findCardMessage(workspaceId, groupId).catch(() => null);
    if (!card?.telegramMessageId) return;
    await this.telegram.bot.api.editMessageReplyMarkup(card.telegramChatId, card.telegramMessageId, { reply_markup: new InlineKeyboard() }).catch(() => undefined);
  }
}
