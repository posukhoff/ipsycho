import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { autoRetry } from "@grammyjs/auto-retry";
import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import { Bot, InlineKeyboard } from "grammy";
import { AccessService } from "../access/access.service.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { SettingsService } from "../settings/settings.service.js";
import { taskKeyboard, weekTakeTodayKeyboard } from "./telegram-ui.js";
import type { BriefingKind } from "../core/digest-policy.js";
import { compactText } from "../core/telegram-ux.js";
import { TelegramUpdatesRepository } from "./telegram-updates.repository.js";
import { safeError } from "../observability/safe-error.js";
import { t } from "./copy/index.js";
import type { AppContext } from "./telegram-context.js";
import { telegramLocale } from "./telegram-locale.js";
import { logger, runWithLogContext } from "../observability/logger.js";

/** Only these update kinds have handlers; asking Telegram for the rest is wasted traffic. */
const ALLOWED_UPDATES = ["message", "callback_query"] as const;
/** Updates from different chats run concurrently; one chat is always processed in order. */
const UPDATE_CONCURRENCY = 16;
/** A turn that has not finished in this long is logged, not killed: the model call has its own 45 s timeout. */
const UPDATE_SLOW_MS = 90_000;
/** An update still `received` this long after arrival belongs to a process that died mid-handler. */
const LOST_UPDATE_AFTER_MS = 10 * 60_000;
/** Telegram rejects longer texts; every outbound message is cut here rather than failing the send. */
export const TELEGRAM_MESSAGE_MAX = 4_000;
/** Commands an unknown user may still reach: registration by invitation and account restore. */
const OPEN_COMMANDS = new Set(["start", "restore"]);

@Injectable()
export class TelegramService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly bot: Bot<AppContext>;
  private runner: RunnerHandle | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly updates: TelegramUpdatesRepository,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
  ) {
    this.bot = new Bot<AppContext>(config.telegramBotToken);
    // Telegram answers 429 with retry_after; without this every burst (a digest hour, a Today
    // screen refresh) surfaced as a failed call instead of a short wait.
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
    this.bot.catch((error) => {
      logger.error("Telegram update failed", {
        updateId: error.ctx.update.update_id,
        error: safeError(error.error),
      });
    });
    this.registerBaseMiddleware();
  }

  private registerBaseMiddleware(): void {
    // The runner processes updates concurrently; this keeps one chat strictly in order so a
    // button tap cannot overtake the message that produced the card it belongs to.
    this.bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

    this.bot.use(async (ctx, next) => {
      if (ctx.chat && ctx.chat.type !== "private") {
        // Answer once, only to something addressed to the bot: silence in a group looks like an outage.
        if (ctx.message?.text?.startsWith("/")) await ctx.reply(t(telegramLocale(null, ctx.from?.language_code), "private_only")).catch(() => undefined);
        return;
      }
      await next();
    });

    // Access is resolved once per update. Handlers read ctx.state instead of repeating the
    // allowlist lookup; an unknown user gets one consistent refusal on every command and button.
    this.bot.use(async (ctx, next) => {
      const telegramUserId = ctx.from?.id;
      const access = telegramUserId ? await this.access.resolveActiveUser(telegramUserId) : null;
      const settings = access ? await this.settings.get(access.user.id) : null;
      ctx.state = { access, settings, locale: telegramLocale(settings?.pinnedLanguage, ctx.from?.language_code ?? settings?.telegramLanguage ?? undefined) };
      // Pushes sent outside an update have no `from` to read: remember the language while there is one.
      if (access && settings) await this.settings.rememberTelegramLanguage(access.user.id, ctx.from?.language_code, settings.telegramLanguage);
      // Every line logged while this update is handled carries the update id and the internal user id.
      if (access && settings) return runWithLogContext({ updateId: ctx.update.update_id, userId: access.user.id }, () => next());
      if (access && !settings) {
        logger.error("active user without settings row", { userId: access.user.id });
        if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx.state.locale, "settings_missing") }).catch(() => undefined);
        else await ctx.reply(t(ctx.state.locale, "settings_missing")).catch(() => undefined);
        return;
      }
      const command = ctx.message?.text?.match(/^\/(\w+)/u)?.[1]?.toLowerCase();
      if (command && OPEN_COMMANDS.has(command)) return next();
      // An account awaiting deletion is not an unknown sender: it asked for this and can undo it.
      const restorable = telegramUserId ? await this.access.findRestorable(telegramUserId) : null;
      if (restorable) {
        const days = Math.max(1, Math.ceil((restorable.deleteAfter.getTime() - Date.now()) / (24 * 60 * 60_000)));
        if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx.state.locale, "deletion_pending_toast") }).catch(() => undefined);
        else if (ctx.message) await ctx.reply(t(ctx.state.locale, "deletion_pending_notice", { days })).catch(() => undefined);
        return;
      }
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx.state.locale, "access_denied_toast") }).catch(() => undefined);
      else if (ctx.message) await ctx.reply(t(ctx.state.locale, "access_denied")).catch(() => undefined);
    });

    // Deduplicate redelivered updates only for users who passed the gate: an unknown sender
    // must not be able to grow this table.
    this.bot.use(async (ctx, next) => {
      const claimed = await this.updates.claim({
        botIdentity: this.config.botIdentity,
        updateId: ctx.update.update_id,
        chatId: ctx.chat?.id,
        messageId: ctx.message?.message_id,
      });
      if (!claimed) return;
      await next();
      // A row still `received` after the handler is one the process died inside; the boot sweep
      // marks those `lost` so the ledger shows what was never answered.
      await this.updates.markHandled(this.config.botIdentity, ctx.update.update_id);
    });
  }

  async sendMessage(telegramUserId: number, text: string, keyboard?: InlineKeyboard): Promise<number> {
    const message = await this.bot.api.sendMessage(telegramUserId, compactText(text, TELEGRAM_MESSAGE_MAX), keyboard ? { reply_markup: keyboard } : {});
    return message.message_id;
  }

  async registrationLink(token: string): Promise<string> {
    const bot = await this.bot.api.getMe();
    if (!bot.username) throw new Error("Telegram bot username is required for invitation links");
    return `https://t.me/${bot.username}?start=join_${token}`;
  }

  async sendReminder(telegramUserId: number, text: string, occurrenceId?: string, locale = telegramLocale(null, undefined), options: { mute?: boolean } = {}): Promise<number> {
    const replyMarkup = occurrenceId ? taskKeyboard(occurrenceId, locale, { snooze: true, ...(options.mute ? { mute: true } : {}) }) : undefined;
    const message = await this.bot.api.sendMessage(telegramUserId, compactText(text, TELEGRAM_MESSAGE_MAX), replyMarkup ? { reply_markup: replyMarkup } : {});
    return message.message_id;
  }

  async sendBriefing(
    telegramUserId: number,
    kind: BriefingKind,
    text: string,
    locale = telegramLocale(null, undefined),
    weekTasks: ReadonlyArray<{ id: string; title: string }> = [],
  ): Promise<number> {
    let keyboard: InlineKeyboard | undefined;
    // One tap gives a task taken for this week its day, so those rows come before the navigation.
    if (kind === "morning") keyboard = weekTakeTodayKeyboard(weekTasks, locale);
    if (kind === "weekly") {
      keyboard = new InlineKeyboard();
      keyboard.text(t(locale, "week_plan_button"), "nav:week");
    }
    const message = await this.bot.api.sendMessage(telegramUserId, compactText(text, TELEGRAM_MESSAGE_MAX), keyboard ? { reply_markup: keyboard } : {});
    return message.message_id;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.publishCommandMenu();
    } catch (error) {
      logger.error("Telegram command menu setup failed", { error: safeError(error) });
    }
    await this.bot.init();
    await this.markLostUpdates();
    this.runner = run(this.bot, {
      runner: { fetch: { allowed_updates: [...ALLOWED_UPDATES] } },
      sink: {
        concurrency: UPDATE_CONCURRENCY,
        timeout: {
          milliseconds: UPDATE_SLOW_MS,
          handler: (update) => logger.warn("Telegram update is taking unusually long", { updateId: update.update_id }),
        },
      },
    });
    logger.info("Telegram long polling started", { botIdentity: this.config.botIdentity });
    void this.runner.task()?.catch((error) => {
      logger.error("Telegram polling stopped with error", { error: safeError(error) });
      process.exitCode = 1;
      process.kill(process.pid, "SIGTERM");
    });
  }

  /** The menu lists what a user can reach; commands with a recovery role (/cancel, /timezone) are included on purpose. */
  private async publishCommandMenu(): Promise<void> {
    const menu = {
      ru: [
        ["today", "План на сегодня"],
        ["tasks", "Задачи"],
        ["week", "План недели"],
        ["goals", "Цели"],
        ["reminders", "Ближайшие напоминания"],
        ["settings", "Настройки"],
        ["timezone", "Часовой пояс"],
        ["language", "Язык интерфейса"],
        ["context", "Что мне учитывать"],
        ["cancel", "Отменить текущий ввод"],
        ["status", "Статус"],
        ["clear", "Очистить AI-историю"],
        ["help", "Помощь"],
      ],
      uk: [
        ["today", "План на сьогодні"],
        ["tasks", "Завдання"],
        ["week", "План тижня"],
        ["goals", "Цілі"],
        ["reminders", "Найближчі нагадування"],
        ["settings", "Налаштування"],
        ["timezone", "Часовий пояс"],
        ["language", "Мова інтерфейсу"],
        ["context", "Що мені враховувати"],
        ["cancel", "Скасувати поточне введення"],
        ["status", "Статус"],
        ["clear", "Очистити AI-історію"],
        ["help", "Допомога"],
      ],
      en: [
        ["today", "Today’s plan"],
        ["tasks", "Tasks"],
        ["week", "Week plan"],
        ["goals", "Goals"],
        ["reminders", "Upcoming reminders"],
        ["settings", "Settings"],
        ["timezone", "Timezone"],
        ["language", "Interface language"],
        ["context", "What I should know"],
        ["cancel", "Cancel current input"],
        ["status", "Status"],
        ["clear", "Clear AI history"],
        ["help", "Help"],
      ],
    } as const;
    const invite = { ru: "Пригласить нового пользователя", uk: "Запросити нового користувача", en: "Invite a new user" } as const;
    const commands = (locale: keyof typeof menu, owner: boolean): Array<{ command: string; description: string }> => {
      const list: Array<{ command: string; description: string }> = menu[locale].map(([command, description]) => ({ command, description }));
      if (!owner) return list;
      const index = list.findIndex((item) => item.command === "status");
      list.splice(index, 0, { command: "invite", description: invite[locale] });
      return list;
    };
    // Telegram prefers a language-specific list when one exists; the fallback keeps an older menu from lingering.
    await this.bot.api.setMyCommands(commands("ru", false));
    for (const locale of ["ru", "uk", "en"] as const) await this.bot.api.setMyCommands(commands(locale, false), { language_code: locale });
    if (this.config.ownerTelegramUserId) {
      const scope = { type: "chat" as const, chat_id: this.config.ownerTelegramUserId };
      await this.bot.api.setMyCommands(commands("ru", true), { scope });
      for (const locale of ["ru", "uk", "en"] as const) await this.bot.api.setMyCommands(commands(locale, true), { scope, language_code: locale });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.runner?.isRunning()) await this.runner.stop();
  }

  /** Updates a previous process accepted but never finished. They are not replayed: Telegram already considers them delivered. */
  private async markLostUpdates(): Promise<void> {
    const count = await this.updates.markLost(this.config.botIdentity, new Date(Date.now() - LOST_UPDATE_AFTER_MS));
    if (count) logger.warn("Telegram updates left unhandled by a previous process", { count });
  }
}
