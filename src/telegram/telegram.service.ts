import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { Bot, InlineKeyboard } from "grammy";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { DatabaseService } from "../database/database.service.js";
import { taskKeyboard, type TelegramOccurrenceStatus } from "./telegram-ui.js";
import type { BriefingKind } from "../core/digest-policy.js";
import { telegramUpdates } from "../database/schema.js";
import { safeError } from "../observability/safe-error.js";

@Injectable()
export class TelegramService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly bot: Bot;
  private pollingStarted = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {
    if (!config.telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is required to run the app");
    this.bot = new Bot(config.telegramBotToken);
    this.bot.catch((error) => {
      console.error("Telegram update failed", {
        updateId: error.ctx.update.update_id,
        error: safeError(error.error),
      });
    });
    this.registerBaseMiddleware();
  }

  private registerBaseMiddleware(): void {
    this.bot.use(async (ctx, next) => {
      if (ctx.chat && ctx.chat.type !== "private") return;
      await next();
    });

    this.bot.use(async (ctx, next) => {
      const inserted = await this.database.db.insert(telegramUpdates).values({
        botIdentity: this.config.botIdentity,
        telegramUpdateId: ctx.update.update_id,
        chatId: ctx.chat?.id,
        telegramMessageId: ctx.message?.message_id,
      }).onConflictDoNothing().returning({ updateId: telegramUpdates.telegramUpdateId });
      if (!inserted.length) return;
      await next();
    });
  }

  async sendMessage(telegramUserId: number, text: string): Promise<number> {
    const message = await this.bot.api.sendMessage(telegramUserId, text);
    return message.message_id;
  }

  async registrationLink(token: string): Promise<string> {
    const bot = await this.bot.api.getMe();
    if (!bot.username) throw new Error("Telegram bot username is required for invitation links");
    return `https://t.me/${bot.username}?start=join_${token}`;
  }

  async sendReminder(telegramUserId: number, text: string, occurrenceId?: string, occurrenceStatus: TelegramOccurrenceStatus = "open"): Promise<number> {
    const replyMarkup = occurrenceId ? taskKeyboard(occurrenceId, occurrenceStatus) : undefined;
    const message = await this.bot.api.sendMessage(telegramUserId, text, replyMarkup ? { reply_markup: replyMarkup } : {});
    return message.message_id;
  }


  async sendBriefing(telegramUserId: number, kind: BriefingKind, text: string, decisionOccurrenceIds: readonly string[] = [], reviewKinds: readonly ("evening" | "weekly")[] = [], reviewDeliveryId?: string): Promise<number> {
    let keyboard: InlineKeyboard | undefined;
    if (decisionOccurrenceIds.length) {
      keyboard = new InlineKeyboard();
      for (const [index, id] of decisionOccurrenceIds.slice(0, 3).entries()) {
        keyboard.text(`✅ ${index + 1}`, `occ:done:${id}`).text(`🕒 ${index + 1}`, `occ:resched:${id}`).row();
      }
    }
    if (kind === "morning") {
      keyboard ??= new InlineKeyboard();
      keyboard.text("📋 Открыть день", "nav:today");
    }
    if (reviewDeliveryId && reviewKinds.length) {
      keyboard ??= new InlineKeyboard();
      if (decisionOccurrenceIds.length) keyboard.row();
      if (reviewKinds.includes("evening")) keyboard.text("💭 Разобрать день", `review:evening:${reviewDeliveryId}`);
      if (reviewKinds.includes("weekly")) keyboard.text("🗓 Спланировать неделю", `review:weekly:${reviewDeliveryId}`);
    }
    const message = await this.bot.api.sendMessage(telegramUserId, text, keyboard ? { reply_markup: keyboard } : {});
    return message.message_id;
  }

  async sendActionResult(input: {
    telegramUserId: number;
    text: string;
    appliedGroupId?: string;
    pendingGroupId?: string;
    checkpointTopicId?: string;
  }): Promise<number> {
    const keyboard = new InlineKeyboard();
    if (input.pendingGroupId) keyboard.text("Подтвердить", `act:confirm:${input.pendingGroupId}`).text("Не делать", `act:cancel:${input.pendingGroupId}`);
    if (input.appliedGroupId) {
      if (input.pendingGroupId) keyboard.row();
      keyboard.text("Отменить изменение", `act:undo:${input.appliedGroupId}`);
    }
    const hasKeyboard = Boolean(input.appliedGroupId || input.pendingGroupId);
    const message = await this.bot.api.sendMessage(input.telegramUserId, input.text, hasKeyboard ? { reply_markup: keyboard } : {});
    return message.message_id;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.pollingStarted = true;
    try {
      const russianCommands = [
        { command: "today", description: "План на сегодня" },
        { command: "tasks", description: "Задачи" },
        { command: "goals", description: "Цели" },
        { command: "reminders", description: "Ближайшие напоминания" },
        { command: "settings", description: "Настройки" },
        { command: "context", description: "Что мне учитывать" },
        { command: "status", description: "Статус" },
        { command: "clear", description: "Очистить AI-историю" },
        { command: "help", description: "Помощь" },
      ];
      // Set both the fallback and Russian scope: Telegram prefers a language-specific
      // command list if one exists, which otherwise can keep an older menu visible.
      await this.bot.api.setMyCommands(russianCommands);
      await this.bot.api.setMyCommands(russianCommands, { language_code: "ru" });
      await this.bot.api.setMyCommands([
        { command: "today", description: "Today’s plan" },
        { command: "tasks", description: "Tasks" },
        { command: "goals", description: "Goals" },
        { command: "reminders", description: "Upcoming reminders" },
        { command: "settings", description: "Settings" },
        { command: "context", description: "What I should know" },
        { command: "status", description: "Status" },
        { command: "clear", description: "Clear AI history" },
        { command: "help", description: "Help" },
      ], { language_code: "en" });
      await this.bot.api.setMyCommands([
        { command: "today", description: "План на сьогодні" },
        { command: "tasks", description: "Завдання" },
        { command: "goals", description: "Цілі" },
        { command: "reminders", description: "Нагадування" },
        { command: "settings", description: "Налаштування" },
        { command: "context", description: "Що мені враховувати" },
        { command: "status", description: "Статус" },
        { command: "clear", description: "Очистити AI-історію" },
        { command: "help", description: "Допомога" },
      ], { language_code: "uk" });
      if (this.config.ownerTelegramUserId) {
        const scope = { type: "chat" as const, chat_id: this.config.ownerTelegramUserId };
        await this.bot.api.setMyCommands([...russianCommands.slice(0, 7), { command: "invite", description: "Пригласить нового пользователя" }, ...russianCommands.slice(7)], { scope });
        await this.bot.api.setMyCommands([
          { command: "today", description: "Today’s plan" }, { command: "tasks", description: "Tasks" }, { command: "goals", description: "Goals" },
          { command: "reminders", description: "Upcoming reminders" }, { command: "settings", description: "Settings" }, { command: "context", description: "What I should know" },
          { command: "status", description: "Status" }, { command: "invite", description: "Invite a new user" }, { command: "clear", description: "Clear AI history" }, { command: "help", description: "Help" },
        ], { scope, language_code: "en" });
        await this.bot.api.setMyCommands([
          { command: "today", description: "План на сьогодні" }, { command: "tasks", description: "Завдання" }, { command: "goals", description: "Цілі" },
          { command: "reminders", description: "Нагадування" }, { command: "settings", description: "Налаштування" }, { command: "context", description: "Що мені враховувати" },
          { command: "status", description: "Статус" }, { command: "invite", description: "Запросити нового користувача" }, { command: "clear", description: "Очистити AI-історію" }, { command: "help", description: "Допомога" },
        ], { scope, language_code: "uk" });
      }
    } catch (error) {
      console.error("Telegram command menu setup failed", safeError(error));
    }
    void this.bot.start({ onStart: () => console.log(`Telegram long polling started (${this.config.botIdentity})`) })
      .catch((error) => {
        console.error("Telegram polling stopped with error", safeError(error));
        process.exitCode = 1;
        process.kill(process.pid, "SIGTERM");
      });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.pollingStarted) await this.bot.stop();
  }
}
