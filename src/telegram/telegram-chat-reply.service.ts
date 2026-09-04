import { Inject, Injectable } from "@nestjs/common";
import { InlineKeyboard } from "grammy";
import { AccessService } from "../access/access.service.js";
import { ChatService, type ChatProcessResult } from "../chat/chat.service.js";
import { safeError } from "../observability/safe-error.js";
import { renderChatResult } from "./telegram-chat-render.js";

export { actionSummary, chatResultKeyboard, renderChatResult, MAX_REPLY_LENGTH, type RenderedChatResult } from "./telegram-chat-render.js";

export type ActiveAccess = NonNullable<Awaited<ReturnType<AccessService["resolveActiveUser"]>>>;

@Injectable()
export class TelegramChatReplyService {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  async reply(ctx: any, access: ActiveAccess, result: ChatProcessResult): Promise<void> {
    if (result.kind === "duplicate") return;
    if (result.kind === "nothing_to_retry") return void await ctx.reply("Нет сохранённых сообщений, которые ждут AI-обработки.");
    if (result.kind === "ai_suspended") return void await ctx.reply("AI-обработка для аккаунта приостановлена. Напоминания и кнопки продолжают работать.");
    if (result.kind === "ai_unavailable") return void await ctx.reply("AI сейчас не настроен или временно недоступен. Попробуй позже.");
    if (result.kind === "rate_limited") return void await ctx.reply("Слишком много AI-запросов за последний час. Попробуй позже; обычные напоминания продолжают работать.");
    if (result.kind === "consent_required") {
      await ctx.reply(`Для AI-чата текст сообщений будет отправляться внешнему провайдеру ${result.provider}. Голосовые при OpenAI отправляются только для расшифровки и не сохраняются как аудио. Разрешить такую обработку?`, {
        reply_markup: new InlineKeyboard().text("Согласен", "ai:consent").text("Не сейчас", "ai:decline"),
      });
      return;
    }

    const { responseText, persistedText, keyboard } = renderChatResult(result);
    try {
      if (result.supersededPendingGroupId) await this.dropCardButtons(ctx, access, result.supersededPendingGroupId);
      const sent = await ctx.reply(responseText, keyboard ? { reply_markup: keyboard } : {});
      if (result.skipAssistantHistory) return;
      await this.chat.recordAssistantMessage({
        workspaceId: access.workspaceId,
        userId: access.user.id,
        content: persistedText,
        telegramChatId: ctx.chat.id,
        telegramMessageId: sent.message_id,
        ...(result.topicId ? { topicId: result.topicId } : {}),
        ...(result.pendingGroupId ? { pendingGroupId: result.pendingGroupId } : {}),
      }).catch((error) => console.error("assistant message persistence failed", { userId: access.user.id, error: safeError(error) }));
    } catch (error) {
      console.error("telegram reply failed after processing", { userId: access.user.id, error: safeError(error) });
    }
  }

  /** A replaced confirmation card keeps its text but loses its buttons; the group is already cancelled. */
  private async dropCardButtons(ctx: any, access: ActiveAccess, groupId: string): Promise<void> {
    const card = await this.chat.findCardMessage(access.workspaceId, groupId).catch(() => null);
    if (!card?.telegramMessageId) return;
    await ctx.api.editMessageReplyMarkup(card.telegramChatId, card.telegramMessageId, { reply_markup: new InlineKeyboard() }).catch(() => undefined);
  }
}
