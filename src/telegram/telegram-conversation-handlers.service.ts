import { Injectable } from "@nestjs/common";
import { InlineKeyboard, type Bot, type CallbackQueryContext, type Filter } from "grammy";
import { VOICE_DOWNLOAD_TIMEOUT_MS } from "../ai/ai-client.js";
import { TranscriptionService } from "../ai/transcription.service.js";
import { BriefingContentService } from "../briefings/briefing-content.service.js";
import { ChatService } from "../chat/chat.service.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { Inject } from "@nestjs/common";
import { localDateAt } from "../core/timezone.js";
import { compactText } from "../core/telegram-ux.js";
import { safeError, safeMessageMetadata } from "../observability/safe-error.js";
import { t } from "./copy/index.js";
import { TelegramChatReplyService } from "./telegram-chat-reply.service.js";
import { activeState, type AppContext } from "./telegram-context.js";
import { TelegramService } from "./telegram.service.js";

const REVIEW_CALLBACK = /^review:(evening|weekly):([0-9a-f-]{36}|start)$/;

/** Voice messages and the review buttons on digests. */
@Injectable()
export class TelegramConversationHandlersService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly telegram: TelegramService,
    private readonly chat: ChatService,
    private readonly transcription: TranscriptionService,
    private readonly briefings: BriefingContentService,
    private readonly chatReply: TelegramChatReplyService,
  ) {}

  register(bot: Bot<AppContext>): void {
    bot.on("message:voice", (ctx) => this.voice(ctx));
    bot.callbackQuery("voice:consent", (ctx) => this.grantVoiceConsent(ctx));
    bot.callbackQuery("voice:decline", async (ctx) => {
      await ctx.answerCallbackQuery({ text: t(ctx.state.locale, "voice_consent_declined_toast") });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    });
    bot.callbackQuery(REVIEW_CALLBACK, (ctx) => this.review(ctx));
  }

  private async voice(ctx: Filter<AppContext, "message:voice">): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    if (access.user.aiStatus !== "enabled") return void await ctx.reply(t(locale, "voice_suspended"));
    const voice = ctx.message.voice;
    const limits = { minutes: Math.floor(this.config.aiVoiceMaxDurationSeconds / 60), mb: Math.floor(this.config.aiVoiceMaxBytes / (1024 * 1024)) };
    if (!this.transcription.acceptsVoice(voice.duration, voice.file_size ?? 0)) return void await ctx.reply(t(locale, "voice_too_long", limits));
    if (!this.transcription.isAvailable()) return void await ctx.reply(t(locale, "voice_openai_only"));
    const gate = await this.chat.voiceGate(access.user.id);
    if (gate === "consent") return this.replyVoiceConsent(ctx);
    if (gate === "unavailable") return void await ctx.reply(t(locale, "voice_openai_only"));
    if (gate === "suspended") return void await ctx.reply(t(locale, "voice_suspended"));
    if (gate === "rate_limited") return void await ctx.reply(t(locale, "voice_rate_limited"));
    let statusMessageId: number | undefined;
    let messageText: string | undefined;
    try {
      const status = await ctx.reply(t(locale, "voice_recognizing"));
      statusMessageId = status.message_id;
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("Telegram did not return a file path");
      const response = await fetch(`https://api.telegram.org/file/bot${this.telegram.bot.token}/${file.file_path}`, { signal: AbortSignal.timeout(VOICE_DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) throw new Error("Telegram file download failed");
      const audio = Buffer.from(await response.arrayBuffer());
      if (!this.transcription.acceptsVoice(voice.duration, audio.length)) throw new Error("voice file too large");

      // Consent may have been revoked while the file was downloading; recheck before the upload.
      const providerGate = await this.chat.voiceGate(access.user.id);
      if (providerGate !== "ready") {
        const text = t(locale, providerGate === "consent" ? "voice_consent_needed" : providerGate === "suspended" ? "voice_suspended" : providerGate === "rate_limited" ? "voice_rate_limited" : "voice_unavailable");
        await ctx.api.editMessageText(ctx.chat.id, statusMessageId, text).catch(() => undefined);
        if (providerGate === "consent") await this.replyVoiceConsent(ctx);
        return;
      }

      const language = voiceLanguage(ctx.from.language_code, settings.pinnedLanguage);
      const text = await this.transcription.transcribe({ workspaceId: access.workspaceId, userId: access.user.id, audio, durationSeconds: voice.duration, ...(language ? { language } : {}) });
      if (!text) return void await ctx.api.editMessageText(ctx.chat.id, statusMessageId, t(locale, "voice_unrecognized")).catch(() => undefined);
      messageText = text;
      await ctx.api.editMessageText(ctx.chat.id, statusMessageId, `🎙 ${compactText(text, 320)}`).catch(() => undefined);
      await ctx.replyWithChatAction("typing").catch(() => undefined);
      const result = await this.chat.processText({
        workspaceId: access.workspaceId, userId: access.user.id, aiStatus: access.user.aiStatus, timezone: settings.timezone,
        language: settings.pinnedLanguage ?? ctx.from.language_code ?? null, text, telegramChatId: ctx.chat.id, telegramMessageId: ctx.message.message_id,
      });
      await this.chatReply.reply(ctx, access, result);
    } catch (error) {
      console.error("voice processing failed", { userId: access.user.id, messageId: ctx.message.message_id, ...(messageText ? { message: safeMessageMetadata(messageText) } : {}), error: safeError(error) });
      const message = t(locale, "voice_failed");
      if (statusMessageId) await ctx.api.editMessageText(ctx.chat.id, statusMessageId, message).catch(() => undefined);
      else await ctx.reply(message);
    }
  }

  private async grantVoiceConsent(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    await this.chat.grantVoiceConsent(access.user.id);
    await ctx.answerCallbackQuery({ text: t(locale, "consent_granted_toast") });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    await ctx.reply(t(locale, "voice_consent_granted"));
  }

  /** A digest button starts the review for that delivery; `review:weekly:start` starts it on demand from settings. */
  private async review(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const match = REVIEW_CALLBACK.exec(ctx.callbackQuery.data);
    const kind = match?.[1] as "evening" | "weekly" | undefined;
    const deliveryId = match?.[2];
    if (!kind || !deliveryId) return void await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") });
    const messageId = ctx.callbackQuery.message?.message_id;
    if (deliveryId !== "start") {
      const current = messageId !== undefined && await this.briefings.isCurrentReviewDelivery({
        workspaceId: access.workspaceId, userId: access.user.id, deliveryId, kind, telegramMessageId: messageId, localDate: localDateAt(new Date(), settings.digestTimezone),
      });
      if (!current) {
        await ctx.answerCallbackQuery({ text: t(locale, "review_stale_toast") });
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
        return;
      }
    }
    try {
      await ctx.answerCallbackQuery({ text: t(locale, kind === "evening" ? "review_start_evening_toast" : "review_start_weekly_toast") });
      const result = await this.chat.startReview({
        workspaceId: access.workspaceId, userId: access.user.id, aiStatus: access.user.aiStatus, timezone: settings.timezone,
        digestTimezone: settings.digestTimezone, language: settings.pinnedLanguage, kind,
      });
      await this.chatReply.reply(ctx, access, result);
    } catch (error) {
      console.error("review callback failed", { userId: access.user.id, error: safeError(error) });
      await ctx.reply(t(locale, "review_failed"));
    }
  }

  private async replyVoiceConsent(ctx: AppContext): Promise<void> {
    const { locale } = activeState(ctx);
    await ctx.reply(t(locale, "voice_consent_prompt"), {
      reply_markup: new InlineKeyboard().text(t(locale, "consent_yes_button"), "voice:consent").text(t(locale, "consent_no_button"), "voice:decline"),
    });
  }
}

function voiceLanguage(telegramLanguage?: string, pinnedLanguage?: string | null): string | undefined {
  const value = pinnedLanguage ?? telegramLanguage;
  const language = value?.split("-")[0]?.toLowerCase();
  return language && /^[a-z]{2}$/u.test(language) ? language : undefined;
}
