import { Inject, Injectable } from "@nestjs/common";
import { InlineKeyboard, type Bot, type CallbackQueryContext, type CommandContext } from "grammy";
import { AccessService, DELETION_GRACE_DAYS, REGISTRATION_INVITE_TTL_DAYS } from "../../access/access.service.js";
import { ChatService } from "../../chat/chat.service.js";
import { APP_CONFIG, type AppConfig } from "../../config.js";
import { DatabaseService } from "../../database/database.service.js";
import { safeError } from "../../observability/safe-error.js";
import { ReminderQueueService } from "../../reminders/reminder-queue.service.js";
import { SettingsService } from "../../settings/settings.service.js";
import { guideIndexText, guideKeyboard, guideText, helpKeyboard, helpText, type GuideDestination } from "../copy/help.js";
import { t } from "../copy/index.js";
import { deterministicCopy } from "../copy/onboarding.js";
import { TelegramChatReplyService } from "../telegram-chat-reply.service.js";
import type { TaskScope } from "../../core/task-list-view.js";
import type { GoalScope } from "../telegram-ui.js";
import { activeState, type AppContext } from "../telegram-context.js";
import { telegramLocale } from "../telegram-locale.js";
import { deployedBuildLine } from "../telegram-ui.js";
import { TelegramService } from "../telegram.service.js";
import { OnboardingService } from "./onboarding.service.js";
import { ScreensService } from "./screens.service.js";
import { logger } from "../../observability/logger.js";

const ACCOUNT_DELETE_CONFIRM = "account:delete_confirm";
const GUIDE_CALLBACK = /^guide:(help|index|tasks|goals|reminders|reports|ai)$/;
const NAV_CALLBACK = /^nav:(today|tasks|reminders|settings|goals)$/;
const TASK_SCOPE_CALLBACK = /^tsk:(overdue|today|week|month|all|nodate):(\d{1,3})$/;
const TODAY_PAGE_CALLBACK = /^tdy:(\d{1,3})$/;
const PAUSED_SERIES_CALLBACK = /^paused:(\d{1,3})$/;
const GROUP_CALLBACK = /^grp:(t|d):([0-9a-f-]{36})$/;
const GOALS_SCOPE_CALLBACK = /^gl:(active|paused|completed):(\d{1,3})$/;
const GOAL_CALLBACK = /^goal:([0-9a-f-]{36})$/;
const REMINDERS_PAGE_CALLBACK = /^rem:p:(\d{1,3})$/;
const HISTORY_CLEAR_CALLBACK = "history:clear";
const PROFILE_OPEN_CALLBACK = "profile:open";
const BACKUP_RETENTION = { daily: 7, weekly: 4 };

/** Commands and buttons that are not about one task: screens, account, consent, help. */
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
    private readonly screens: ScreensService,
    private readonly onboarding: OnboardingService,
  ) {}

  register(bot: Bot<AppContext>): void {
    bot.command(["tasks", "task"], (ctx) => this.screens.tasks_(ctx));
    bot.command("reminders", (ctx) => this.screens.reminders_(ctx));
    bot.command("goals", (ctx) => this.screens.goals(ctx));
    bot.command("today", (ctx) => this.screens.today(ctx));
    bot.command("settings", (ctx) => this.screens.settings_(ctx));
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
    bot.callbackQuery(GUIDE_CALLBACK, (ctx) => this.guide(ctx));
    bot.callbackQuery(NAV_CALLBACK, (ctx) => this.navigate(ctx));
    bot.callbackQuery(TASK_SCOPE_CALLBACK, (ctx) => this.tasksPage(ctx));
    bot.callbackQuery(TODAY_PAGE_CALLBACK, (ctx) => this.todayPage(ctx));
    bot.callbackQuery(PAUSED_SERIES_CALLBACK, (ctx) => this.pausedSeriesPage(ctx));
    bot.callbackQuery(GROUP_CALLBACK, (ctx) => this.openGroup(ctx));
    bot.callbackQuery(GOALS_SCOPE_CALLBACK, (ctx) => this.goalsPage(ctx));
    bot.callbackQuery(GOAL_CALLBACK, (ctx) => this.openGoal(ctx));
    bot.callbackQuery(REMINDERS_PAGE_CALLBACK, (ctx) => this.remindersPage(ctx));
    bot.callbackQuery(HISTORY_CLEAR_CALLBACK, (ctx) => this.clearHistory(ctx));
    bot.callbackQuery(PROFILE_OPEN_CALLBACK, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.openProfile(ctx);
    });
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
      ctx.state = { access, settings, locale: telegramLocale(settings.pinnedLanguage, ctx.from?.language_code) };
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
    const { locale } = activeState(ctx);
    await ctx.reply(helpText(this.config, locale), { reply_markup: helpKeyboard(locale) });
  }

  private async openProfile(ctx: AppContext): Promise<void> {
    const { access } = activeState(ctx);
    const result = await this.chat.startProfile({ workspaceId: access.workspaceId, userId: access.user.id });
    await this.chatReply.reply(ctx, access, result);
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

  private async guide(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const section = GUIDE_CALLBACK.exec(ctx.callbackQuery.data)?.[1] as GuideDestination | undefined;
    if (!section) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    await ctx.answerCallbackQuery();
    if (section === "help") return this.screens.present(ctx, helpText(this.config, locale), helpKeyboard(locale), true);
    if (section === "index") return this.screens.present(ctx, guideIndexText(locale), guideKeyboard(locale), true);
    await this.screens.present(ctx, guideText(section, locale), guideKeyboard(locale, section), true);
  }

  private async navigate(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const target = NAV_CALLBACK.exec(ctx.callbackQuery.data)?.[1];
    if (!target) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    await ctx.answerCallbackQuery();
    if (target === "today") return this.screens.today(ctx, true);
    if (target === "tasks") return this.screens.tasks_(ctx, true);
    if (target === "reminders") return this.screens.reminders_(ctx, true);
    if (target === "goals") return this.screens.goals(ctx, true);
    return this.screens.settings_(ctx, true);
  }

  /** The task list on one date window and page; the window itself is carried by the button, not stored. */
  private async tasksPage(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const match = TASK_SCOPE_CALLBACK.exec(ctx.callbackQuery.data);
    if (!match?.[1] || match[2] === undefined) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    await ctx.answerCallbackQuery();
    await this.screens.tasks_(ctx, true, match[1] as TaskScope, Number(match[2]));
  }

  private async pausedSeriesPage(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const match = PAUSED_SERIES_CALLBACK.exec(ctx.callbackQuery.data);
    if (match?.[1] === undefined) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    await ctx.answerCallbackQuery();
    await this.screens.pausedSeries_(ctx, true, Number(match[1]));
  }

  private async todayPage(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const page = TODAY_PAGE_CALLBACK.exec(ctx.callbackQuery.data)?.[1];
    if (page === undefined) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    await ctx.answerCallbackQuery();
    await this.screens.today(ctx, true, Number(page));
  }

  /**
   * A collapsed line stands for rows that may have moved or been closed since the message was
   * drawn, so the group is looked up again; when it is gone the screen is redrawn instead.
   */
  private async openGroup(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const match = GROUP_CALLBACK.exec(ctx.callbackQuery.data);
    const source = match?.[1] === "d" ? "today" : "tasks";
    const key = match?.[2];
    if (!key) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    const shown = await this.screens.taskGroup(ctx, source, key);
    if (shown) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery({ text: t(locale, "list_changed_toast") });
    await (source === "today" ? this.screens.today(ctx, true) : this.screens.tasks_(ctx, true));
  }

  private async goalsPage(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const match = GOALS_SCOPE_CALLBACK.exec(ctx.callbackQuery.data);
    if (!match?.[1] || match[2] === undefined) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    await ctx.answerCallbackQuery();
    await this.screens.goals(ctx, true, match[1] as GoalScope, Number(match[2]));
  }

  private async openGoal(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const goalId = GOAL_CALLBACK.exec(ctx.callbackQuery.data)?.[1];
    if (!goalId) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    const shown = await this.screens.goal(ctx, goalId);
    if (shown) return void (await ctx.answerCallbackQuery());
    await ctx.answerCallbackQuery({ text: t(locale, "list_changed_toast") });
    await this.screens.goals(ctx, true);
  }

  private async remindersPage(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const page = REMINDERS_PAGE_CALLBACK.exec(ctx.callbackQuery.data)?.[1];
    if (page === undefined) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    await ctx.answerCallbackQuery();
    await this.screens.reminders_(ctx, true, Number(page));
  }

  private async clearHistory(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const count = await this.chat.clearConversation(access.workspaceId, access.user.id);
    await ctx.answerCallbackQuery({ text: t(locale, "history_cleared_toast", { count }) }).catch(() => undefined);
    // The button lives on the settings card; refresh it in place instead of matching the card by its title.
    await this.screens.settings_(ctx, true);
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
