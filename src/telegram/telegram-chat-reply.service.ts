import { Inject, Injectable } from "@nestjs/common";
import { InlineKeyboard } from "grammy";
import { ChatService, type ChatProcessResult } from "../chat/chat.service.js";
import { formatLocalTime } from "../core/time-presentation.js";
import { safeError } from "../observability/safe-error.js";
import { t } from "./copy/index.js";
import { renderChatResult } from "./telegram-chat-render.js";
import type { ActiveAccess, AppContext } from "./telegram-context.js";
import { logger } from "../observability/logger.js";

export type { ActiveAccess } from "./telegram-context.js";
export { actionSummary, chatResultKeyboard, renderChatResult, MAX_REPLY_LENGTH, type RenderedChatResult } from "./telegram-chat-render.js";

/** Delivers a chat result to the user who asked: gate messages, the consent card, or the rendered turn. */
@Injectable()
export class TelegramChatReplyService {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  async reply(ctx: AppContext, access: ActiveAccess, result: ChatProcessResult): Promise<void> {
    const locale = ctx.state.locale;
    if (result.kind === "duplicate") return;
    if (result.kind === "nothing_to_retry") return void (await ctx.reply(t(locale, "chat_nothing_to_retry")));
    if (result.kind === "ai_suspended") return void (await ctx.reply(t(locale, "chat_ai_suspended")));
    if (result.kind === "ai_unavailable") return void (await ctx.reply(t(locale, "chat_ai_unavailable")));
    if (result.kind === "rate_limited") {
      const timezone = ctx.state.settings?.timezone ?? "UTC";
      return void (await ctx.reply(t(locale, "chat_rate_limited", { limit: this.chat.maxMessagesPerHour, until: formatLocalTime(new Date(Date.now() + 60 * 60_000), timezone) })));
    }
    if (result.kind === "consent_required") {
      await ctx.reply(t(locale, "consent_prompt", { provider: result.provider }), {
        reply_markup: new InlineKeyboard().text(t(locale, "consent_yes_button"), "ai:consent").text(t(locale, "consent_no_button"), "ai:decline"),
      });
      return;
    }

    const { persistedText, keyboard } = renderChatResult(result, locale);
    try {
      if (result.supersededPendingGroupId) await this.dropCardButtons(ctx, access, result.supersededPendingGroupId);
      const sent = await ctx.reply(persistedText, keyboard ? { reply_markup: keyboard } : {});
      if (result.skipAssistantHistory) return;
      await this.chat
        .recordAssistantMessage({
          workspaceId: access.workspaceId,
          userId: access.user.id,
          content: persistedText,
          telegramChatId: ctx.chat?.id ?? access.user.telegramUserId,
          telegramMessageId: sent.message_id,
          ...(result.topicId ? { topicId: result.topicId } : {}),
          ...(result.pendingGroupId ? { pendingGroupId: result.pendingGroupId } : {}),
        })
        .catch((error) => logger.error("assistant message persistence failed", { userId: access.user.id, error: safeError(error) }));
    } catch (error) {
      logger.error("telegram reply failed after processing", { userId: access.user.id, error: safeError(error) });
    }
  }

  /** A replaced confirmation card keeps its text but loses its buttons; the group is already cancelled. */
  private async dropCardButtons(ctx: AppContext, access: ActiveAccess, groupId: string): Promise<void> {
    const card = await this.chat.findCardMessage(access.workspaceId, groupId).catch(() => null);
    if (!card?.telegramMessageId) return;
    await ctx.api.editMessageReplyMarkup(card.telegramChatId, card.telegramMessageId, { reply_markup: new InlineKeyboard() }).catch(() => undefined);
  }
}
