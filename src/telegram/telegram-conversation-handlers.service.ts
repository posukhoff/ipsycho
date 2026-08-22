import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { InlineKeyboard } from "grammy";
import { AccessService } from "../access/access.service.js";
import { TranscriptionService } from "../ai/transcription.service.js";
import { BriefingContentService } from "../briefings/briefing-content.service.js";
import { ChatService } from "../chat/chat.service.js";
import { localDateAt } from "../core/timezone.js";
import { compactText } from "../core/telegram-ux.js";
import { safeError, safeMessageMetadata } from "../observability/safe-error.js";
import { SettingsService } from "../settings/settings.service.js";
import { TelegramChatReplyService } from "./telegram-chat-reply.service.js";
import { TelegramService } from "./telegram.service.js";

const REVIEW_CALLBACK = /^review:(evening|weekly):([0-9a-f-]{36})$/;

@Injectable()
export class TelegramConversationHandlersService implements OnModuleInit {
  constructor(
    @Inject(TelegramService) private readonly telegram: TelegramService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(TranscriptionService) private readonly transcription: TranscriptionService,
    @Inject(BriefingContentService) private readonly briefings: BriefingContentService,
    @Inject(TelegramChatReplyService) private readonly chatReply: TelegramChatReplyService,
  ) {}

  onModuleInit(): void {
    this.registerVoiceHandler();
    this.telegram.bot.callbackQuery("voice:consent", async (ctx) => this.handleVoiceConsent(ctx));
    this.telegram.bot.callbackQuery("voice:decline", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from.id);
      if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
      await ctx.answerCallbackQuery({ text: "Голосовой ввод не включён" });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    });
    this.telegram.bot.callbackQuery(REVIEW_CALLBACK, async (ctx) => this.handleReviewCallback(ctx));
  }

  private registerVoiceHandler(): void {
    this.telegram.bot.on("message:voice", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from.id);
      if (!access) return ctx.reply("Этот бот закрыт. Доступ выдаётся владельцем проекта.");
      const settings = await this.settings.get(access.user.id);
      if (!settings) return ctx.reply("Не найдены настройки пользователя.");
      if (access.user.aiStatus !== "enabled") return ctx.reply("AI-обработка для аккаунта приостановлена. Голосовой ввод недоступен.");
      const voice = ctx.message.voice;
      if (!this.transcription.acceptsVoice(voice.duration, voice.file_size ?? 0)) return ctx.reply("Голосовое слишком длинное или большое. Отправь запись до 5 минут и 20 МБ либо текст.");
      if (!this.transcription.isAvailable()) return ctx.reply("Голосовой ввод сейчас доступен только при настроенном OpenAI.");
      const gate = await this.chat.voiceGate(access.user.id);
      if (gate === "consent") return this.replyVoiceConsent(ctx);
      if (gate === "unavailable") return ctx.reply("Голосовой ввод сейчас доступен только при настроенном OpenAI.");
      if (gate === "suspended") return ctx.reply("AI-обработка для аккаунта приостановлена. Голосовой ввод недоступен.");
      if (gate === "rate_limited") return ctx.reply("Слишком много AI-запросов за последний час. Отправь текст позже.");
      let statusMessageId: number | undefined;
      let messageText: string | undefined;
      try {
        const status = await ctx.reply("🎙 Распознаю…");
        statusMessageId = status.message_id;
        const file = await ctx.getFile();
        if (!file.file_path) throw new Error("Telegram did not return a file path");
        const response = await fetch(`https://api.telegram.org/file/bot${this.telegram.bot.token}/${file.file_path}`);
        if (!response.ok) throw new Error("Telegram file download failed");
        const audio = Buffer.from(await response.arrayBuffer());
        if (!this.transcription.acceptsVoice(voice.duration, audio.length)) throw new Error("voice file too large");

        const providerGate = await this.chat.voiceGate(access.user.id);
        if (providerGate !== "ready") {
          const text = providerGate === "consent" ? "Нужно подтвердить AI-обработку."
            : providerGate === "suspended" ? "AI-обработка приостановлена. Голосовой ввод недоступен."
              : providerGate === "rate_limited" ? "Слишком много AI-запросов за последний час."
                : "Голосовой ввод сейчас недоступен.";
          if (statusMessageId) await ctx.api.editMessageText(ctx.chat.id, statusMessageId, text).catch(() => undefined);
          if (providerGate === "consent") await this.replyVoiceConsent(ctx);
          return;
        }

        const language = voiceLanguage(ctx.from.language_code, settings.pinnedLanguage);
        const text = await this.transcription.transcribe({
          workspaceId: access.workspaceId,
          userId: access.user.id,
          audio,
          durationSeconds: voice.duration,
          ...(language ? { language } : {}),
        });
        if (!text) {
          if (statusMessageId) await ctx.api.editMessageText(ctx.chat.id, statusMessageId, "Не удалось распознать речь. Попробуй записать короче или отправь текст.").catch(() => undefined);
          return;
        }
        messageText = text;
        if (statusMessageId) {
          await ctx.api.editMessageText(ctx.chat.id, statusMessageId, `🎙 ${compactText(text, 320)}`).catch(() => undefined);
        }
        const result = await this.chat.processText({
          workspaceId: access.workspaceId,
          userId: access.user.id,
          aiStatus: access.user.aiStatus,
          timezone: settings.timezone,
          language: settings.pinnedLanguage ?? ctx.from?.language_code ?? null,
          text,
          telegramChatId: ctx.chat.id,
          telegramMessageId: ctx.message.message_id,
        });
        await this.chatReply.reply(ctx, access, result);
      } catch (error) {
        console.error("voice processing failed", { userId: access.user.id, messageId: ctx.message.message_id, ...(messageText ? { message: safeMessageMetadata(messageText) } : {}), error: safeError(error) });
        const message = "Не удалось обработать голосовое. Попробуй отправить его короче или напиши текст.";
        if (statusMessageId) await ctx.api.editMessageText(ctx.chat.id, statusMessageId, message).catch(() => undefined);
        else await ctx.reply(message);
      }
    });
  }


  private async handleVoiceConsent(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    await this.chat.grantVoiceConsent(access.user.id);
    await ctx.answerCallbackQuery({ text: "Согласие сохранено" });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    await ctx.reply("Голосовой ввод включён. Отправь голосовое ещё раз; предыдущее аудио не переотправляется автоматически.");
  }

  private async handleReviewCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const match = REVIEW_CALLBACK.exec(ctx.callbackQuery.data);
    const kind = match?.[1] as "evening" | "weekly" | undefined;
    const deliveryId = match?.[2];
    if (!kind || !deliveryId) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
    const settings = await this.settings.get(access.user.id);
    if (!settings) return ctx.answerCallbackQuery({ text: "Настройки не найдены" });
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!messageId || !await this.briefings.isCurrentReviewDelivery({
      workspaceId: access.workspaceId,
      userId: access.user.id,
      deliveryId,
      kind,
      telegramMessageId: messageId,
      localDate: localDateAt(new Date(), settings.digestTimezone),
    })) return ctx.answerCallbackQuery({ text: "Эта кнопка обзора уже устарела" });

    try {
      await ctx.answerCallbackQuery({ text: kind === "evening" ? "Начинаю разбор" : "Начинаю планирование" });
      const result = await this.chat.startReview({
        workspaceId: access.workspaceId,
        userId: access.user.id,
        aiStatus: access.user.aiStatus,
        timezone: settings.timezone,
        digestTimezone: settings.digestTimezone,
        language: settings.pinnedLanguage,
        kind,
      });
      await this.chatReply.reply(ctx, access, result);
    } catch (error) {
      console.error("review callback failed", { userId: access.user.id, error: safeError(error) });
      await ctx.reply("Не удалось запустить обзор. Попробуй позже.");
    }
  }

  private async replyVoiceConsent(ctx: any): Promise<void> {
    await ctx.reply("Для AI-обработки текст будет отправляться внешнему провайдеру, а голосовое — OpenAI только для расшифровки. Аудио не сохраняется; распознанный текст обрабатывается и хранится как обычное сообщение. Разрешить?", {
      reply_markup: new InlineKeyboard().text("Согласен", "voice:consent").text("Не сейчас", "voice:decline"),
    });
  }
}

function voiceLanguage(telegramLanguage?: string, pinnedLanguage?: string | null): string | undefined {
  const value = pinnedLanguage ?? telegramLanguage;
  const language = value?.split("-")[0]?.toLowerCase();
  return language && /^[a-z]{2}$/u.test(language) ? language : undefined;
}
