import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { autoRetry } from "@grammyjs/auto-retry";
import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import { Bot, InlineKeyboard } from "grammy";
import { AccessService } from "../access/access.service.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { SettingsService } from "../settings/settings.service.js";
import { launchOnlyKeyboard, taskKeyboard, weeklyBriefingKeyboard } from "./telegram-ui.js";
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
/** The chat menu button's label. One button serves every chat and Telegram takes no language for it. */
const CHAT_MENU_BUTTON_TEXT = "Открыть";

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
      ctx.state = {
        access,
        settings,
        locale: telegramLocale(settings?.pinnedLanguage, ctx.from?.language_code ?? settings?.telegramLanguage ?? undefined),
        webAppUrl: this.webAppUrl,
      };
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

  /**
   * The Mini App origin the launch buttons point at, or `null` when the flag is off.
   *
   * The config schema refuses `WEBAPP_ENABLED=true` without a URL, so this is non-null exactly
   * when the app exists. With the flag off nothing downstream ever builds a `web_app` button: a
   * button that opens nothing is a worse dead end than no button.
   */
  private get webAppUrl(): string | null {
    return this.config.webAppEnabled ? (this.config.webAppUrl ?? null) : null;
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

  async sendReminder(
    telegramUserId: number,
    text: string,
    occurrenceId?: string,
    locale = telegramLocale(null, undefined),
    options: { mute?: boolean; recurring?: boolean } = {},
  ): Promise<number> {
    const replyMarkup = occurrenceId
      ? taskKeyboard(occurrenceId, locale, {
          snooze: true,
          ...(options.mute ? { mute: true } : {}),
          ...(options.recurring ? { recurring: true } : {}),
          webAppUrl: this.webAppUrl,
        })
      : undefined;
    const message = await this.bot.api.sendMessage(telegramUserId, compactText(text, TELEGRAM_MESSAGE_MAX), replyMarkup ? { reply_markup: replyMarkup } : {});
    return message.message_id;
  }

  async sendBriefing(
    telegramUserId: number,
    kind: BriefingKind,
    text: string,
    locale = telegramLocale(null, undefined),
    idleGoals: ReadonlyArray<{ id: string; title: string }> = [],
  ): Promise<number> {
    // The morning card used to carry one «делаю сегодня» row per task taken for the week — a list of
    // up to eight taps, which is browsing, so it is the day's screen in the app now (design.md § 1).
    let keyboard: InlineKeyboard | null | undefined;
    if (kind === "morning") keyboard = launchOnlyKeyboard(this.webAppUrl, { name: "today" }, locale);
    if (kind === "weekly") keyboard = weeklyBriefingKeyboard(idleGoals, locale, this.webAppUrl);
    // With the app off and no idle goal to propose, the week card has no buttons at all; Telegram
    // rejects an empty `inline_keyboard`, so the markup is attached only when something is on it.
    const markup = keyboard?.inline_keyboard.some((row) => row.length > 0) ? { reply_markup: keyboard } : {};
    const message = await this.bot.api.sendMessage(telegramUserId, compactText(text, TELEGRAM_MESSAGE_MAX), markup);
    return message.message_id;
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.publishCommandMenu();
    } catch (error) {
      logger.error("Telegram command menu setup failed", { error: safeError(error) });
    }
    try {
      await this.publishChatMenuButton();
    } catch (error) {
      logger.error("Telegram chat menu button setup failed", { error: safeError(error) });
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

  /**
   * The menu lists what a user can reach in chat, and after task 11 that is the conversation plus
   * the deterministic gates: the browsing commands are screens in the Mini App, reached through the
   * chat menu button. `/context` is on the list because it starts a conversation, not a screen. Telegram caches this list per client, so publishing it in the same release
   * that removes the handlers is what stops the menu advertising a command that has moved.
   */
  private async publishCommandMenu(): Promise<void> {
    const menu = {
      ru: [
        ["context", "Что мне учитывать"],
        ["cancel", "Отменить текущий ввод"],
        ["retry_ai", "Повторить обработку"],
        ["status", "Статус"],
        ["clear", "Очистить AI-историю"],
        ["help", "Помощь"],
      ],
      uk: [
        ["context", "Що мені враховувати"],
        ["cancel", "Скасувати поточне введення"],
        ["retry_ai", "Повторити обробку"],
        ["status", "Статус"],
        ["clear", "Очистити AI-історію"],
        ["help", "Допомога"],
      ],
      en: [
        ["context", "What I should know"],
        ["cancel", "Cancel current input"],
        ["retry_ai", "Retry AI processing"],
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

  /**
   * The chat menu button, the app's second entrance (task 10.3).
   *
   * With the flag off this makes no API call at all: the bot must behave exactly as it did before
   * the app existed, and `setChatMenuButton` is a write to state Telegram keeps.
   *
   * Turning the flag off later does **not** put the button back — Telegram has already stored it,
   * and nothing here is clever enough to know whether an operator set it by hand. Resetting it to
   * `{"type":"commands"}` is a documented step of the rollback in `docs/DEPLOYMENT.md` § 7.
   *
   * The label is the one user-facing string the bot cannot localize: `setChatMenuButton` takes no
   * `language_code` and one button serves every chat, so it is a constant here rather than a key
   * in three dictionaries where two translations could never be shown. It matches the manual
   * `curl` fallback in `docs/DEPLOYMENT.md` § 6 so the two cannot drift apart unnoticed.
   */
  private async publishChatMenuButton(): Promise<void> {
    const url = this.webAppUrl;
    if (!url) return;
    await this.bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: CHAT_MENU_BUTTON_TEXT, web_app: { url } } });
    logger.info("Telegram chat menu button points at the Mini App", { botIdentity: this.config.botIdentity });
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
