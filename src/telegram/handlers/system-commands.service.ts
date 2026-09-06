import { Inject, Injectable } from "@nestjs/common";
import { InlineKeyboard, type Bot, type CallbackQueryContext, type CommandContext } from "grammy";
import { AccessService, DELETION_GRACE_DAYS, REGISTRATION_INVITE_TTL_DAYS } from "../../access/access.service.js";
import { ChatService } from "../../chat/chat.service.js";
import { APP_CONFIG, type AppConfig } from "../../config.js";
import { DatabaseService } from "../../database/database.service.js";
import { safeError } from "../../observability/safe-error.js";
import { ReminderQueueService } from "../../reminders/reminder-queue.service.js";
import { SettingsService } from "../../settings/settings.service.js";
import { helpText } from "../copy/help.js";
import { t } from "../copy/index.js";
import { deterministicCopy } from "../copy/onboarding.js";
import { TelegramChatReplyService } from "../telegram-chat-reply.service.js";
import { activeState, type AppContext } from "../telegram-context.js";
import { telegramLocale } from "../telegram-locale.js";
import { deployedBuildLine, launchOnlyKeyboard } from "../telegram-ui.js";
import { TelegramService } from "../telegram.service.js";
import { OnboardingService } from "./onboarding.service.js";
import { ContextService } from "../../context/context.service.js";
import { logger } from "../../observability/logger.js";

const ACCOUNT_DELETE_CONFIRM = "account:delete_confirm";
const GOAL_STEP_CALLBACK = /^goal:step:([0-9a-f-]{36})$/;
const BACKUP_RETENTION = { daily: 7, weekly: 4 };

/** Commands and buttons that are not about one task: account, consent, help, onboarding. */
@Injectable()
export class SystemCommandsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly telegram: TelegramService,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly chat: ChatService,
    private readonly database: DatabaseService,
    private readonly reminderQueue: ReminderQueueService,
    private readonly chatReply: TelegramChatReplyService,
    private readonly onboarding: OnboardingService,
    private readonly context: ContextService,
  ) {}

  register(bot: Bot<AppContext>): void {
    bot.command("status", (ctx) => this.status(ctx));
    bot.command("clear", (ctx) => this.clear(ctx));
    bot.command("start", (ctx) => this.start(ctx));
    bot.command("invite", (ctx) => this.invite(ctx));
    bot.command("help", (ctx) => this.help(ctx));
    bot.command("context", (ctx) => this.openProfile(ctx));
    bot.command("delete_account", (ctx) => this.deleteAccount(ctx));
    bot.command("restore", (ctx) => this.restore(ctx));
    bot.command("ai_revoke", (ctx) => this.revokeAi(ctx));
    bot.command("retry_ai", (ctx) => this.retryAi(ctx));
    bot.command("cancel", (ctx) => this.cancel(ctx));

    bot.callbackQuery(ACCOUNT_DELETE_CONFIRM, (ctx) => this.confirmDeletion(ctx));
    bot.callbackQuery("ai:consent", (ctx) => this.grantConsent(ctx));
    bot.callbackQuery("ai:decline", (ctx) => this.declineConsent(ctx));
    bot.callbackQuery(GOAL_STEP_CALLBACK, (ctx) => this.goalStep(ctx));
  }

  private async status(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const database = await this.database.pool
      .query("select 1")
      .then(() => true)
      .catch(() => false);
    const queue = await this.reminderQueue.queueSummary().catch(() => null);
    const ai =
      access.user.aiStatus !== "enabled"
        ? t(locale, "status_ai_suspended")
        : this.chat.isAiConfigured()
          ? t(locale, "status_ai_configured", { provider: this.chat.providerName })
          : t(locale, "status_ai_missing");
    const lines = [
      t(locale, "status_server"),
      t(locale, database ? "status_db_ok" : "status_db_failed"),
      t(locale, "status_telegram"),
      ai,
      ...(queue ? [t(locale, "status_deliveries", { pending: queue.pending })] : []),
      ...(queue?.ambiguous ? [t(locale, "status_deliveries_ambiguous", { ambiguous: queue.ambiguous })] : []),
      deployedBuildLine(this.config.appCommit, locale),
    ];
    await ctx.reply(lines.join("\n"));
  }

  private async clear(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const count = await this.chat.clearConversation(access.workspaceId, access.user.id);
    await ctx.reply(t(locale, "history_cleared", { count }));
  }

  private async start(ctx: CommandContext<AppContext>): Promise<void> {
    const fallbackLocale = telegramLocale(null, ctx.from?.language_code);
    if (!ctx.state.access) {
      const token = registrationTokenFromStart(ctx.message?.text ?? "");
      if (!token) return void (await ctx.reply(t(fallbackLocale, "access_denied")));
      const registration = await this.access.registerFromInvite(token, ctx.from!.id);
      if (registration.kind === "already_registered") return void (await ctx.reply(t(fallbackLocale, "invite_already_registered")));
      if (registration.kind !== "created") return void (await ctx.reply(t(fallbackLocale, "invite_invalid")));
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      const settings = access ? await this.settings.get(access.user.id) : null;
      if (!access || !settings) throw new Error("invited user registration did not create active access");
      ctx.state = { ...ctx.state, access, settings, locale: telegramLocale(settings.pinnedLanguage, ctx.from?.language_code) };
    }
    const { settings, locale } = activeState(ctx);
    if (!settings.onboardingCompletedAt) return this.onboarding.begin(ctx);
    await ctx.reply(deterministicCopy(locale).ready);
  }

  private async invite(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    if (!canCreateRegistrationInvite(this.config.ownerTelegramUserId, ctx.from!.id)) return void (await ctx.reply(t(locale, "invite_not_allowed")));
    try {
      const invite = await this.access.createRegistrationInvite(access.user.id);
      const link = await this.telegram.registrationLink(invite.token);
      await ctx.reply(t(locale, "invite_created", { link, days: REGISTRATION_INVITE_TTL_DAYS }));
    } catch (error) {
      logger.error("registration invite creation failed", { userId: access.user.id, error: safeError(error) });
      await ctx.reply(t(locale, "invite_failed"));
    }
  }

  private async help(ctx: CommandContext<AppContext>): Promise<void> {
    const { locale, webAppUrl } = activeState(ctx);
    // The guide pages were themselves a screen tree; what is left is one text plus the way in.
    const launch = launchOnlyKeyboard(webAppUrl, { name: "today" }, locale);
    await ctx.reply(helpText(this.config, locale), launch ? { reply_markup: launch } : {});
  }

  /**
   * `/context` starts the profile interview: it asks the model and answers in chat, so it is a
   * conversation turn and stays here with `goal:step:*` rather than moving to the app (design.md
   * § 1). Only its screen moved — the app's profile is a read-only view of what the interview
   * writes, so when the app is on the turn is followed by one short line carrying the way there.
   * With the flag off the command is exactly the single model turn it has always been.
   */
  private async openProfile(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, settings, locale, webAppUrl } = activeState(ctx);
    const result = await this.chat.startProfile({
      workspaceId: access.workspaceId,
      userId: access.user.id,
      language: settings.pinnedLanguage ?? ctx.from?.language_code ?? null,
    });
    await this.chatReply.reply(ctx, access, result);
    const launch = launchOnlyKeyboard(webAppUrl, { name: "profile" }, locale);
    if (launch) await ctx.reply(t(locale, "webapp_profile_hint"), { reply_markup: launch }).catch(() => undefined);
  }

  private async deleteAccount(ctx: CommandContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    await ctx.reply(t(locale, "delete_prompt", { days: DELETION_GRACE_DAYS, daily: BACKUP_RETENTION.daily, weekly: BACKUP_RETENTION.weekly }), {
      reply_markup: new InlineKeyboard().text(t(locale, "delete_confirm_button"), ACCOUNT_DELETE_CONFIRM),
    });
  }

  /** Open to a user whose account is locked for deletion: the access gate lets /restore through. */
  private async restore(ctx: CommandContext<AppContext>): Promise<void> {
    const locale = ctx.state.locale;
    const restored = await this.access.restoreDeletion(ctx.from!.id);
    await ctx.reply(t(locale, restored ? "restore_done" : "restore_unavailable"));
  }

  private async revokeAi(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    await this.chat.revokeConsent(access.user.id);
    await ctx.reply(t(locale, "ai_revoked"));
  }

  private async retryAi(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    try {
      const result = await this.chat.retryLatest({
        workspaceId: access.workspaceId,
        userId: access.user.id,
        aiStatus: access.user.aiStatus,
        timezone: settings.timezone,
        language: settings.pinnedLanguage ?? ctx.from?.language_code ?? null,
      });
      await this.chatReply.reply(ctx, access, result);
    } catch (error) {
      logger.error("AI retry failed", { userId: access.user.id, error: safeError(error) });
      await ctx.reply(t(locale, "retry_failed"));
    }
  }

  private async cancel(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    await Promise.all([this.settings.setPendingInput(access.user.id, null), this.chat.pauseConversation(access.workspaceId, access.user.id)]);
    await ctx.reply(t(locale, "cancel_done"));
  }

  private async confirmDeletion(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    try {
      await this.access.requestDeletion(ctx.from.id);
      await ctx.answerCallbackQuery({ text: t(locale, "delete_scheduled_toast") });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
      await ctx.reply(t(locale, "delete_scheduled", { days: DELETION_GRACE_DAYS }));
    } catch (error) {
      logger.error("account deletion request failed", { userId: access.user.id, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: t(locale, "delete_failed_toast") }).catch(() => undefined);
    }
  }

  /** Consent granted from the card: the message that was blocked is processed now, not retyped. */
  private async grantConsent(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    await this.chat.grantConsent(access.user.id, access.workspaceId);
    await ctx.answerCallbackQuery({ text: t(locale, "consent_granted_toast") });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    const result = await this.chat
      .retryLatest({
        workspaceId: access.workspaceId,
        userId: access.user.id,
        aiStatus: access.user.aiStatus,
        timezone: settings.timezone,
        language: settings.pinnedLanguage ?? ctx.from.language_code ?? null,
      })
      .catch((error) => {
        logger.error("replay after consent failed", { userId: access.user.id, error: safeError(error) });
        return { kind: "nothing_to_retry" as const };
      });
    if (result.kind === "nothing_to_retry") return void (await ctx.reply(t(locale, "consent_granted")));
    await ctx.reply(t(locale, "consent_granted_replaying"));
    await this.chatReply.reply(ctx, access, result);
  }

  private async declineConsent(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    await ctx.answerCallbackQuery({ text: t(locale, "consent_declined_toast") });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    await ctx.reply(t(locale, "consent_declined"));
  }

  /**
   * The one thing the bot proposes on its own: a goal nothing has moved for weeks. The week card
   * names it, and this button asks the model for a concrete step — the same turn the user could
   * have typed, so it is journaled, reported and undoable like any other.
   */
  private async goalStep(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const goalId = GOAL_STEP_CALLBACK.exec(ctx.callbackQuery.data)?.[1];
    if (!goalId) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    const overview = await this.context.findGoalOverview(access.workspaceId, goalId).catch(() => null);
    if (!overview || overview.goal.status !== "active") return void (await ctx.answerCallbackQuery({ text: t(locale, "goal_step_gone_toast") }));
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.from.id;
    const result = await this.chat.processText({
      workspaceId: access.workspaceId,
      userId: access.user.id,
      aiStatus: access.user.aiStatus,
      timezone: settings.timezone,
      language: settings.pinnedLanguage ?? ctx.from?.language_code ?? null,
      text: t(locale, "goal_step_prompt", { title: overview.goal.title }),
      telegramChatId: chatId,
      telegramMessageId: ctx.callbackQuery.message?.message_id ?? 0,
    });
    await this.chatReply.reply(ctx, access, result);
  }
}

export function registrationTokenFromStart(text: string): string | null {
  return (
    text
      .replace(/^\/\S+(?:@\S+)?\s*/u, "")
      .trim()
      .match(/^join_([A-Za-z0-9_-]{32,64})$/u)?.[1] ?? null
  );
}

export function canCreateRegistrationInvite(ownerTelegramUserId: number | undefined, telegramUserId: number): boolean {
  return ownerTelegramUserId !== undefined && ownerTelegramUserId === telegramUserId;
}
