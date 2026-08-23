import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { MessagesRepository } from "../messages/messages.repository.js";
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
          const suffix = actionSummary(result.pendingCount, result.pendingTitles ?? [], result.warnings);
          const text = [result.text, result.report, suffix].filter((part) => part && part.trim()).join("\n\n");
          const telegramMessageId = await this.telegram.sendActionResult({
            telegramUserId: row.user.telegramUserId,
            text,
            ...(result.appliedGroupId ? { appliedGroupId: result.appliedGroupId } : {}),
            ...(result.pendingGroupId ? { pendingGroupId: result.pendingGroupId } : {}),
            ...(result.checkpointTopicId ? { checkpointTopicId: result.checkpointTopicId } : {}),
          });
          await this.chat.recordAssistantMessage({
            workspaceId: row.message.workspaceId,
            userId: row.message.userId,
            content: text,
            telegramChatId: row.user.telegramUserId,
            telegramMessageId,
            ...(result.topicId ? { topicId: result.topicId } : {}),
          });
        } catch (error) {
          console.error("automatic AI retry failed", { messageId: row.message.id, message: safeMessageMetadata(row.message.content), error: safeError(error) });
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function actionSummary(pending: number, pendingTitles: readonly string[], warnings: readonly string[]): string {
  const parts = [...warnings];
  if (pending) parts.push([`⏳ Нужно подтвердить (${pending}):`, ...pendingTitles.slice(0, 8).map((title) => `• ${title}`)].join("\n"));
  return parts.join("\n\n");
}
