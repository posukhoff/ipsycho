import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { InlineKeyboard } from "grammy";
import { AccessService } from "../access/access.service.js";
import { ActionStateUncertainError, ActionsService } from "../actions/actions.service.js";
import { BriefingContentService } from "../briefings/briefing-content.service.js";
import { ChatService } from "../chat/chat.service.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { ContextService } from "../context/context.service.js";
import { detectConversationControl } from "../core/conversation-control.js";
import { parseCustomFollowUpInput, parseRescheduleInput } from "../core/deterministic-input.js";
import { quickRescheduleSchedule, type QuickRescheduleChoice } from "../core/telegram-ux.js";
import type { RescheduleFields } from "../core/reschedule.js";
import { formatIsoInstantInTimezone } from "../core/timezone.js";
import { localDateAt } from "../core/timezone.js";
import { renderAppliedReport } from "../core/applied-report.js";
import { formatLocalDateTime } from "../core/time-presentation.js";
import type { ProposedActionDraft } from "../core/ai-actions.js";
import { ReminderSchedulingService } from "../reminders/reminder-scheduling.service.js";
import { SettingsService, type PendingInput } from "../settings/settings.service.js";
import { TasksService } from "../tasks/tasks.service.js";
import { TelegramChatReplyService } from "./telegram-chat-reply.service.js";
import { TelegramService } from "./telegram.service.js";
import { telegramLocale, type TelegramLocale } from "./telegram-locale.js";
import {
  deployedBuildLine,
  fuzzyTaskCardText,
  fuzzyTaskDetailKeyboard,
  goalsOverviewText,
  quickRescheduleKeyboard,
  quickRescheduleReasonKeyboard,
  quickRescheduleReasonText,
  settingsKeyboard,
  settingsText,
  resultCheckKeyboard,
  startedTaskKeyboard,
  taskCardText,
  taskDetailKeyboard,
  taskKeyboard,
  taskMoreKeyboard,
  taskListKeyboard,
  tasksOverviewText,
  terminalTaskText,
  todayText,
  type QuickRescheduleReasonCode,
} from "./telegram-ui.js";
import { safeError, safeMessageMetadata } from "../observability/safe-error.js";

const OCCURRENCE_CALLBACK = /^occ:(seen|start|done|skip|cant|cancel|cancel_one|resched|more|back|check):([0-9a-f-]{36})$/;
const FOLLOW_UP_CALLBACK = /^follow:(seen|result):(15m|1h|evening|custom|none):([0-9a-f-]{36})$/;
const SERIES_CALLBACK = /^series:(pause|cancel):([0-9a-f-]{36})$/;
const ACTION_CALLBACK = /^act:(confirm|cancel|undo):([0-9a-f-]{36})$/;
const ONBOARD_CALLBACK = /^onb:(digests|quiet|weekly):(on|off|default)$/;
const TIMEZONE_APPLY_CALLBACK = /^tzapply:(digests|quiet|both)$/;
const TOPIC_CONTROL_CALLBACK = /^topic:(continue|conclude|end):([0-9a-f-]{36})$/;
const ACCOUNT_DELETE_CONFIRM = "account:delete_confirm";
const REMINDER_CALLBACK = /^rem:cancel:([0-9a-f-]{36})$/;
const QUICK_RESCHEDULE_CALLBACK = /^resched:(1h|evening|tomorrow|custom):([0-9a-f-]{36})$/;
const QUICK_RESCHEDULE_REASON_CALLBACK = /^rr:(h|e|t):(t|d|e|o):([0-9a-f-]{36})$/;
const VIEW_CALLBACK = /^view:(occ|task):([0-9a-f-]{36})$/;
const PREFS_CALLBACK = /^prefs:(morning|evening|weekly|quiet|snooze):(toggle|morning)$/;
const NAV_CALLBACK = /^nav:(today|today_all|tasks|reminders|settings|goals)$/;
const HISTORY_CLEAR_CALLBACK = "history:clear";
const PROFILE_OPEN_CALLBACK = "profile:open";
const GUIDE_CALLBACK = /^guide:(help|index|tasks|goals|reminders|reports|ai)$/;

@Injectable()
export class TelegramHandlersService implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TelegramService) private readonly telegram: TelegramService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(ReminderSchedulingService) private readonly reminders: ReminderSchedulingService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ContextService) private readonly context: ContextService,
    @Inject(ActionsService) private readonly actions: ActionsService,
    @Inject(BriefingContentService) private readonly briefings: BriefingContentService,
    @Inject(TelegramChatReplyService) private readonly chatReply: TelegramChatReplyService,
  ) {}

  onModuleInit(): void {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.registerSystemCommands();
    this.registerSettingsCommands();
    this.registerCallbacks();
    this.registerTextHandler();
  }

  private registerSystemCommands(): void {
    const bot = this.telegram.bot;

    const showTasks = async (ctx: any) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return ctx.reply("Этот бот закрыт. Доступ выдаётся владельцем проекта.");
      await this.replyTasks(ctx, access.workspaceId, access.user.id);
    };
    bot.command("tasks", showTasks);
    // Creation is natural-language first; this alias is only a convenient way
    // to open the list for people who instinctively type /task.
    bot.command("task", showTasks);

    bot.command("reminders", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return ctx.reply("Этот бот закрыт. Доступ выдаётся владельцем проекта.");
      await this.replyReminders(ctx, access.workspaceId, access.user.id);
    });

    bot.command("goals", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return ctx.reply("Этот бот закрыт. Доступ выдаётся владельцем проекта.");
      await this.replyGoals(ctx, access.workspaceId, access.user.id);
    });

    bot.command("today", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return ctx.reply("Этот бот закрыт. Доступ выдаётся владельцем проекта.");
      await this.replyToday(ctx, access.workspaceId, access.user.id);
    });

    bot.command("status", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return ctx.reply("Сервер отвечает, но этот аккаунт не имеет доступа к боту.");
      const locale = await this.localeFor(ctx, access.user.id);
      const ai = access.user.aiStatus === "enabled"
        ? this.chat.isAiConfigured() ? `настроен (${this.chat.providerName})` : "не настроен"
        : "приостановлен для аккаунта";
      const build = deployedBuildLine(this.config.appCommit, locale);
      await ctx.reply(locale === "uk"
        ? `✅ Сервер IPsycho доступний\n✅ PostgreSQL доступна\n✅ Telegram доставив цю відповідь\n🤖 AI: ${access.user.aiStatus === "enabled" ? this.chat.isAiConfigured() ? `налаштований (${this.chat.providerName})` : "не налаштований" : "призупинений для акаунта"}\n${build}`
        : `✅ Сервер IPsycho доступен\n✅ PostgreSQL доступна\n✅ Telegram доставил этот ответ\n🤖 AI: ${ai}\n${build}`);
    });

    bot.command("clear", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return ctx.reply("Этот бот закрыт. Доступ выдаётся владельцем проекта.");
      const count = await this.chat.clearConversation(access.workspaceId, access.user.id);
      const locale = await this.localeFor(ctx, access.user.id);
      await ctx.reply(aiHistoryClearedText(locale, count));
    });

    bot.command("start", async (ctx) => {
      let access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) {
        const token = registrationTokenFromStart(ctx.message?.text ?? "");
        if (!token) return ctx.reply(registrationDeniedText(telegramLocale(null, ctx.from?.language_code)));
        const registration = await this.access.registerFromInvite(token, ctx.from!.id);
        if (registration.kind !== "created") return ctx.reply(registrationInviteInvalidText(telegramLocale(null, ctx.from?.language_code)));
        access = await this.access.resolveActiveUser(ctx.from!.id);
        if (!access) throw new Error("invited user registration did not create active access");
      }
      const settings = await this.settings.get(access.user.id);
      if (!settings) return ctx.reply("Не найдены настройки пользователя.");
      const copy = deterministicCopy(await this.localeFor(ctx, access.user.id));
      if (!settings.onboardingCompletedAt) {
        await ctx.reply(copy.startOnboarding, { reply_markup: new InlineKeyboard().text(copy.yes, "onb:digests:on").text(copy.no, "onb:digests:off") });
        return;
      }
      await ctx.reply(copy.ready);
    });

    bot.command("invite", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return ctx.reply(registrationDeniedText(telegramLocale(null, ctx.from?.language_code)));
      const locale = await this.localeFor(ctx, access.user.id);
      if (!canCreateRegistrationInvite(this.config.ownerTelegramUserId, ctx.from!.id)) return ctx.reply(registrationInviteNotAllowedText(locale));
      try {
        const invite = await this.access.createRegistrationInvite(access.user.id);
        const link = await this.telegram.registrationLink(invite.token);
        await ctx.reply(registrationInviteCreatedText(locale, link));
      } catch (error) {
        console.error("registration invite creation failed", { userId: access.user.id, error: safeError(error) });
        await ctx.reply(registrationInviteFailedText(locale));
      }
    });

    bot.command("help", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return;
      const locale = await this.localeFor(ctx, access.user.id);
      await ctx.reply(helpText(this.config, locale), { reply_markup: helpKeyboard(locale) });
    });

    bot.command("delete_account", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return ctx.reply("Активный аккаунт не найден.");
      await ctx.reply(
        "Удаление остановит AI, сводки и напоминания сразу. Данные будут окончательно удалены через 14 дней; до этого аккаунт можно восстановить командой /restore. Остаточные данные могут сохраняться в зашифрованных резервных копиях до истечения политики хранения: 7 ежедневных и 4 еженедельных копии.",
        { reply_markup: new InlineKeyboard().text("Подтвердить удаление", ACCOUNT_DELETE_CONFIRM) },
      );
    });

    bot.command("restore", async (ctx) => {
      const restored = await this.access.restoreDeletion(ctx.from!.id);
      await ctx.reply(restored ? "Аккаунт восстановлен. Будущие актуальные уведомления снова активны." : "Аккаунт не ожидает удаления или срок восстановления уже истёк.");
    });

    bot.command("ai_revoke", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return;
      await this.chat.revokeConsent(access.user.id);
      await ctx.reply("Согласие на внешнюю AI-обработку отозвано. Напоминания, сводки и кнопки продолжат работать.");
    });

    bot.command("retry_ai", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return;
      const settings = await this.settings.get(access.user.id);
      if (!settings) return ctx.reply("Не найдены настройки пользователя.");
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
        console.error("AI retry failed", { userId: access.user.id, error: safeError(error) });
        await ctx.reply("Повторная обработка пока не удалась. Сообщение сохранено.");
      }
    });

    bot.command("cancel", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return;
      await Promise.all([
        this.settings.setPendingInput(access.user.id, null),
        this.chat.pauseConversation(access.workspaceId, access.user.id),
      ]);
      await ctx.reply("Текущий ввод и разбор остановлены. Уже сохранённые задачи и решения не изменены.");
    });
  }

  private registerSettingsCommands(): void {
    const bot = this.telegram.bot;

    bot.command("settings", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return;
      await this.replySettings(ctx, access.workspaceId, access.user.id);
    });

    bot.command("context", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return;
      await this.openProfile(ctx, access);
    });

    bot.command("timezone", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return;
      const value = commandArgs(ctx.message!.text);
      if (!value) return ctx.reply("Формат: /timezone Europe/Kyiv");
      try {
        await this.settings.setTimezone(access.user.id, value);
        await ctx.reply(
          `Основной часовой пояс: ${value}. Существующие разовые задачи и повторяющиеся серии автоматически не сдвигаются. Сводки и quiet hours тоже сохраняют свой прежний часовой пояс, пока ты явно не применишь новый.`,
          { reply_markup: new InlineKeyboard()
            .text("К сводкам", "tzapply:digests")
            .text("К quiet hours", "tzapply:quiet")
            .row()
            .text("К обоим", "tzapply:both") },
        );
      } catch {
        await ctx.reply("Неизвестный IANA timezone. Пример: Europe/Kyiv");
      }
    });

    bot.command("language", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return;
      const value = commandArgs(ctx.message!.text).trim();
      try {
        const automatic = value.toLowerCase() === "auto";
        const normalized = await this.settings.setLanguage(access.user.id, automatic ? null : value);
        await ctx.reply(automatic ? "Язык интерфейса снова определяется по Telegram." : `Язык интерфейса закреплён: ${normalized}. AI всё равно отвечает на языке текущего сообщения.`);
      } catch {
        await ctx.reply("Формат: /language auto, /language ru или /language uk");
      }
    });

    bot.command("morning", async (ctx) => this.handleDigestCommand(ctx, "morning"));
    bot.command("evening", async (ctx) => this.handleDigestCommand(ctx, "evening"));

    bot.command("weekly", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return;
      const parts = commandArgs(ctx.message!.text).split(/\s+/u).filter(Boolean);
      if (!parts.length) {
        const settings = await this.settings.get(access.user.id);
        if (!settings) return ctx.reply("Не найдены настройки пользователя.");
        const now = new Date();
        const briefing = await this.briefings.build({
          workspaceId: access.workspaceId,
          kind: "weekly",
          localDate: localDateAt(now, settings.timezone),
          timezone: settings.timezone,
          now,
        });
        await ctx.reply(briefing.text);
        return;
      }
      const enabled = parts[0] === "on";
      if ((enabled && parts.length !== 3) || (!enabled && (parts[0] !== "off" || parts.length !== 1))) {
        return ctx.reply("Формат: /weekly on <день 1-7> <HH:MM> или /weekly off");
      }
      try {
        await this.settings.setWeekly({
          userId: access.user.id,
          enabled,
          ...(enabled ? { weekday: Number(parts[1]), time: parts[2]! } : {}),
        });
        await ctx.reply(enabled ? "Недельный обзор включён." : "Недельный обзор выключен.");
      } catch (error) {
        console.warn("weekly settings update failed", { userId: access.user.id, error: safeError(error) });
        await ctx.reply("Не удалось изменить настройку. Проверь день недели (1–7) и время HH:MM.");
      }
    });

    bot.command("quiet", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return;
      const parts = commandArgs(ctx.message!.text).split(/\s+/u).filter(Boolean);
      try {
        if (!parts.length || parts[0] === "default") {
          await this.settings.setQuietHours(access.user.id, { enabled: true, weekdayStart: "22:00", weekdayEnd: "08:00", weekendStart: "23:00", weekendEnd: "09:00" });
          return ctx.reply("Quiet hours: будни 22:00–08:00, выходные 23:00–09:00.");
        }
        if (parts[0] === "off") {
          await this.settings.setQuietHours(access.user.id, { enabled: false });
          return ctx.reply("Quiet hours выключены.");
        }
        const [weekdayStart, weekdayEnd, weekendStart, weekendEnd] = parts;
        if (parts.length === 4 && weekdayStart && weekdayEnd && weekendStart && weekendEnd) {
          await this.settings.setQuietHours(access.user.id, { enabled: true, weekdayStart, weekdayEnd, weekendStart, weekendEnd });
          return ctx.reply("Quiet hours обновлены.");
        }
        return ctx.reply("Формат: /quiet default, /quiet off или /quiet 22:00 08:00 23:00 09:00");
      } catch {
        return ctx.reply("Неверное время. Используй HH:MM.");
      }
    });

    bot.command("snooze", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return;
      const row = await this.settings.get(access.user.id);
      if (!row) return;
      const value = commandArgs(ctx.message!.text).toLowerCase();
      try {
        if (value === "off") {
          await this.settings.snoozeUntil(access.user.id, null);
          return ctx.reply("Временная тишина выключена.");
        }
        if (value === "morning" || value === "утро" || value === "ранок") {
          const until = await this.settings.snoozeUntilMorning(access.user.id);
          return ctx.reply(`Молчу до ${formatLocal(until, row.timezone)}.`);
        }
        const minutes = Number(value);
        if (!Number.isInteger(minutes) || minutes < 15 || minutes > 7 * 24 * 60) return ctx.reply("Формат: /snooze morning, /snooze off или /snooze <минуты 15..10080>");
        const until = new Date(Date.now() + minutes * 60_000);
        await this.settings.snoozeUntil(access.user.id, until);
        return ctx.reply(`Молчу до ${formatLocal(until, row.timezone)}.`);
      } catch {
        return ctx.reply("Не удалось изменить временную тишину.");
      }
    });

    bot.command("reminder_defaults", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from!.id);
      if (!access) return;
      const parts = commandArgs(ctx.message!.text).split(/\s+/u).filter(Boolean);
      try {
        if (parts[0] === "seen" && parts.length === 4) {
          await this.settings.setReminderDefaults({ userId: access.user.id, seenNormalMinutes: Number(parts[1]), seenRequiredMinutes: Number(parts[2]), seenCriticalMinutes: Number(parts[3]) });
          return ctx.reply("Интервалы Seen обновлены.");
        }
        if (parts[0] === "event" && parts[1]) {
          const offsets = parts[1].split(",").map(Number);
          await this.settings.setReminderDefaults({ userId: access.user.id, eventOffsets: offsets });
          const sorted = [...offsets].sort((a, b) => a - b);
          const dense = sorted.some((value, index) => index > 0 && value - sorted[index - 1]! < 15);
          const warning = offsets.length > 8 || dense
            ? " Предупреждение: напоминаний много или часть стоит ближе 15 минут; система объединит слишком близкие контакты."
            : "";
          return ctx.reply(`Стандартные напоминания событий обновлены.${warning}`);
        }
        if (parts[0] === "task" && parts[1]) {
          await this.settings.setReminderDefaults({ userId: access.user.id, plannedTaskOffsetMinutes: Number(parts[1]) });
          return ctx.reply("Стандартное напоминание плановой задачи обновлено.");
        }
        if (parts[0] === "critical" && parts[1]) {
          await this.settings.setReminderDefaults({ userId: access.user.id, criticalPostDueMinutes: Number(parts[1]) });
          return ctx.reply("Интервал критической эскалации обновлён.");
        }
        return ctx.reply("Примеры: /reminder_defaults seen 60 30 15; event -60,-15,0; task 0; critical 60");
      } catch (error) {
        console.warn("reminder defaults update failed", { userId: access.user.id, error: safeError(error) });
        return ctx.reply("Не удалось изменить настройку. Проверь числа и формат команды.");
      }
    });
  }

  private registerCallbacks(): void {
    const bot = this.telegram.bot;

    bot.callbackQuery(ONBOARD_CALLBACK, async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from.id);
      if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
      const match = ONBOARD_CALLBACK.exec(ctx.callbackQuery.data);
      const step = match?.[1]; const value = match?.[2];
      if (!step || !value) return;
      if (step === "digests") {
        await this.settings.setDigestPreset(access.user.id, value === "on");
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
        const copy = deterministicCopy(await this.localeFor(ctx, access.user.id));
        await ctx.answerCallbackQuery({ text: copy.saved });
        await ctx.reply(copy.quietPrompt, { reply_markup: new InlineKeyboard().text(copy.defaultLabel, "onb:quiet:default").text(copy.off, "onb:quiet:off") });
        return;
      }
      if (step === "quiet") {
        await this.settings.setQuietHours(access.user.id, value === "off" ? { enabled: false } : { enabled: true, weekdayStart: "22:00", weekdayEnd: "08:00", weekendStart: "23:00", weekendEnd: "09:00" });
        const copy = deterministicCopy(await this.localeFor(ctx, access.user.id));
        await ctx.answerCallbackQuery({ text: copy.saved });
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
        await ctx.reply(copy.weeklyPrompt, { reply_markup: new InlineKeyboard().text(copy.yes, "onb:weekly:on").text(copy.no, "onb:weekly:off") });
        return;
      }
      await this.settings.setWeeklyPreset(access.user.id, value === "on");
      await this.settings.completeOnboarding(access.user.id);
      const copy = deterministicCopy(await this.localeFor(ctx, access.user.id));
      await ctx.answerCallbackQuery({ text: copy.done });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
      await ctx.reply(copy.onboardingDone);
    });


    bot.callbackQuery(TIMEZONE_APPLY_CALLBACK, async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from.id);
      if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
      const target = TIMEZONE_APPLY_CALLBACK.exec(ctx.callbackQuery.data)?.[1] as "digests" | "quiet" | "both" | undefined;
      if (!target) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
      await this.settings.applyProfileTimezone(access.user.id, target);
      await ctx.answerCallbackQuery({ text: "Часовой пояс применён" });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    });

    bot.callbackQuery(ACCOUNT_DELETE_CONFIRM, async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from.id);
      if (!access) return ctx.answerCallbackQuery({ text: "Аккаунт уже недоступен" });
      try {
        await this.access.requestDeletion(ctx.from.id);
        await ctx.answerCallbackQuery({ text: "Удаление запланировано" });
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
        await ctx.reply("Аккаунт заблокирован. В течение 14 дней его можно восстановить командой /restore.");
      } catch (error) {
        console.error("account deletion request failed", { userId: access.user.id, error: safeError(error) });
        await ctx.answerCallbackQuery({ text: "Не удалось запланировать удаление" }).catch(() => undefined);
      }
    });

    bot.callbackQuery("system:ping", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from.id);
      await ctx.answerCallbackQuery({ text: access ? "Работает" : "Нет доступа" });
    });

    bot.callbackQuery("ai:consent", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from.id);
      if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
      await this.chat.grantConsent(access.user.id, access.workspaceId);
      await ctx.answerCallbackQuery({ text: "Согласие сохранено" });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
      await ctx.reply("Готово. Предыдущее сообщение не отправляется автоматически: отправь текст или голосовое ещё раз.");
    });

    bot.callbackQuery("ai:decline", async (ctx) => {
      const access = await this.access.resolveActiveUser(ctx.from.id);
      if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
      await ctx.answerCallbackQuery({ text: "AI не включён" });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    });

    bot.callbackQuery(TOPIC_CONTROL_CALLBACK, async (ctx) => this.handleTopicControlCallback(ctx));
    bot.callbackQuery(REMINDER_CALLBACK, async (ctx) => this.handleReminderCallback(ctx));
    bot.callbackQuery(ACTION_CALLBACK, async (ctx) => this.handleActionCallback(ctx));
    bot.callbackQuery(HISTORY_CLEAR_CALLBACK, async (ctx) => this.handleHistoryClearCallback(ctx));
    bot.callbackQuery(GUIDE_CALLBACK, async (ctx) => this.handleGuideCallback(ctx));
    bot.callbackQuery(PROFILE_OPEN_CALLBACK, async (ctx) => this.handleProfileOpenCallback(ctx));
    bot.callbackQuery(FOLLOW_UP_CALLBACK, async (ctx) => this.handleFollowUpCallback(ctx));
    bot.callbackQuery(SERIES_CALLBACK, async (ctx) => this.handleSeriesCallback(ctx));
    bot.callbackQuery(QUICK_RESCHEDULE_CALLBACK, async (ctx) => this.handleQuickRescheduleCallback(ctx));
    bot.callbackQuery(QUICK_RESCHEDULE_REASON_CALLBACK, async (ctx) => this.handleQuickRescheduleReasonCallback(ctx));
    bot.callbackQuery(VIEW_CALLBACK, async (ctx) => this.handleViewCallback(ctx));
    bot.callbackQuery(PREFS_CALLBACK, async (ctx) => this.handlePrefsCallback(ctx));
    bot.callbackQuery(NAV_CALLBACK, async (ctx) => this.handleNavCallback(ctx));
    bot.callbackQuery(OCCURRENCE_CALLBACK, async (ctx) => this.handleOccurrenceCallback(ctx));
  }

  private async presentScreen(ctx: any, text: string, keyboard?: InlineKeyboard, edit = false): Promise<void> {
    const options = { reply_markup: keyboard ?? new InlineKeyboard() };
    if (edit && ctx.callbackQuery?.message) {
      const edited = await ctx.editMessageText(text, options).then(() => true).catch(() => false);
      if (edited) return;
    }
    await ctx.reply(text, keyboard ? { reply_markup: keyboard } : {});
  }

  private async localeFor(ctx: any, userId: string): Promise<TelegramLocale> {
    const settings = await this.settings.get(userId);
    return telegramLocale(settings?.pinnedLanguage, ctx.from?.language_code);
  }

  private async replyTasks(ctx: any, workspaceId: string, userId: string, edit = false): Promise<void> {
    const items = await this.tasks.listForTelegram(workspaceId, 50);
    const locale = await this.localeFor(ctx, userId);
    await this.presentScreen(ctx, tasksOverviewText(items, locale), taskListKeyboard(items, locale, { visibleCount: 8 }), edit);
  }

  private async replyReminders(ctx: any, workspaceId: string, userId: string, edit = false): Promise<void> {
    const locale = await this.localeFor(ctx, userId);
    const uk = locale === "uk";
    const rows = await this.reminders.listUpcoming({ workspaceId, userId, limit: 8 });
    const lines = rows.length ? [uk ? "🔔 Найближчі нагадування" : "🔔 Ближайшие напоминания", ""] : [uk ? "🔔 Нагадування" : "🔔 Напоминания", "", uk ? "Найближчих нагадувань немає." : "Ближайших напоминаний нет."];
    rows.forEach(({ delivery, task }, index) => {
      lines.push(`${index + 1}. ${task.title} · ${formatLocal(delivery.scheduledFor, task.timezone)}`);
    });
    if (rows.length) lines.push("", uk ? "Щоб скасувати або перенести нагадування, напиши це звичайним повідомленням." : "Чтобы отменить или перенести напоминание, напиши это обычным сообщением.");
    await this.presentScreen(ctx, lines.join("\n"), guideKeyboard(locale, "reminders"), edit);
  }

  private async replyToday(ctx: any, workspaceId: string, userId: string, edit = false, showAll = false): Promise<void> {
    const row = await this.settings.get(userId);
    if (!row) return void await this.presentScreen(ctx, "Не найдены настройки пользователя.", undefined, edit);
    const now = new Date();
    const localDate = localDateAt(now, row.timezone);
    const [items, completed] = await Promise.all([
      this.tasks.listTodayForTelegram(workspaceId, localDate, 20),
      this.tasks.listCompletedTodayForTelegram(workspaceId, localDate),
    ]);
    const locale = await this.localeFor(ctx, userId);
    await this.presentScreen(ctx, todayText(items, localDate, locale, completed.length, showAll ? 20 : 6), taskListKeyboard(items, locale, { showAll: !showAll, allCount: items.length, visibleCount: showAll ? 20 : 6 }), edit);
  }

  private async replyGoals(ctx: any, workspaceId: string, userId: string, edit = false): Promise<void> {
    const items = await this.context.goalsOverview(workspaceId);
    const locale = await this.localeFor(ctx, userId);
    await this.presentScreen(ctx, goalsOverviewText(items, locale), guideKeyboard(locale, "goals"), edit);
  }

  private async replySettings(ctx: any, workspaceId: string, userId: string, edit = false): Promise<void> {
    const row = await this.settings.get(userId);
    if (!row) return void await this.presentScreen(ctx, "Не найдены настройки пользователя.", undefined, edit);
    const historyMessageCount = await this.chat.historyMessageCount(workspaceId, userId);
    const locale = telegramLocale(row.pinnedLanguage, ctx.from?.language_code);
    await this.presentScreen(ctx, settingsText(row, new Date(), historyMessageCount, locale), settingsKeyboard(locale), edit);
  }

  private async handlePrefsCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const match = PREFS_CALLBACK.exec(ctx.callbackQuery.data);
    const key = match?.[1];
    const action = match?.[2];
    if (!key || !action) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
    const row = await this.settings.get(access.user.id);
    if (!row) return ctx.answerCallbackQuery({ text: "Настройки не найдены" });
    try {
      if (key === "morning") await this.settings.setDigest({ userId: access.user.id, kind: "morning", enabled: !row.morningDigestEnabled });
      else if (key === "evening") await this.settings.setDigest({ userId: access.user.id, kind: "evening", enabled: !row.eveningDigestEnabled });
      else if (key === "weekly") await this.settings.setWeekly({ userId: access.user.id, enabled: !row.weeklyReviewEnabled });
      else if (key === "quiet") await this.settings.setQuietHours(access.user.id, { enabled: !row.quietHoursEnabled });
      else if (key === "snooze" && action === "morning") await this.settings.snoozeUntilMorning(access.user.id);
      const updated = await this.settings.get(access.user.id);
      if (!updated) throw new Error("settings missing after update");
      await ctx.answerCallbackQuery({ text: key === "snooze" ? "Молчу до утра" : "Сохранено" });
      const historyMessageCount = await this.chat.historyMessageCount(access.workspaceId, access.user.id);
      const locale = telegramLocale(updated.pinnedLanguage, ctx.from?.language_code);
      await ctx.editMessageText(settingsText(updated, new Date(), historyMessageCount, locale), { reply_markup: settingsKeyboard(locale) }).catch(() => undefined);
    } catch (error) {
      console.error("settings callback failed", { userId: access.user.id, key, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: "Не удалось изменить настройку" }).catch(() => undefined);
    }
  }

  private async handleProfileOpenCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    await ctx.answerCallbackQuery();
    await this.openProfile(ctx, access);
  }

  private async openProfile(ctx: any, access: NonNullable<Awaited<ReturnType<AccessService["resolveActiveUser"]>>>): Promise<void> {
    const result = await this.chat.startProfile({ workspaceId: access.workspaceId, userId: access.user.id });
    await this.chatReply.reply(ctx, access, result);
  }

  private async handleNavCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const target = NAV_CALLBACK.exec(ctx.callbackQuery.data)?.[1];
    if (!target) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
    await ctx.answerCallbackQuery();
    if (target === "today") return this.replyToday(ctx, access.workspaceId, access.user.id, true);
    if (target === "today_all") return this.replyToday(ctx, access.workspaceId, access.user.id, true, true);
    if (target === "tasks") return this.replyTasks(ctx, access.workspaceId, access.user.id, true);
    if (target === "reminders") return this.replyReminders(ctx, access.workspaceId, access.user.id, true);
    if (target === "goals") return this.replyGoals(ctx, access.workspaceId, access.user.id, true);
    return this.replySettings(ctx, access.workspaceId, access.user.id, true);
  }

  private async handleGuideCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const section = GUIDE_CALLBACK.exec(ctx.callbackQuery.data)?.[1] as GuideDestination | undefined;
    if (!section) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
    const locale = await this.localeFor(ctx, access.user.id);
    await ctx.answerCallbackQuery();
    if (section === "help") return this.presentScreen(ctx, helpText(this.config, locale), helpKeyboard(locale), true);
    if (section === "index") return this.presentScreen(ctx, guideIndexText(locale), guideKeyboard(locale), true);
    await this.presentScreen(ctx, guideText(section, locale), guideKeyboard(locale, section), true);
  }

  /** Full task card: row fields plus checklist, goal and the next reminder that will actually fire. */
  private async taskCard(workspaceId: string, context: NonNullable<Awaited<ReturnType<TasksService["getOccurrenceContext"]>>>): Promise<string> {
    const [extras, nextReminderAt] = await Promise.all([
      this.tasks.getTaskCardExtras(workspaceId, context.task.id).catch(() => ({ checklist: [], goalTitle: null })),
      this.reminders.nextUserReminderAt(workspaceId, context.occurrence.id).catch(() => null),
    ]);
    return taskCardText({ ...context.task, ...extras, nextReminderAt }, context.occurrence);
  }

  private async handleViewCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const match = VIEW_CALLBACK.exec(ctx.callbackQuery.data);
    const kind = match?.[1];
    const id = match?.[2];
    if (!kind || !id) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
    if (kind === "occ") {
      const context = await this.tasks.getOccurrenceContext(access.workspaceId, id);
      if (!context) return ctx.answerCallbackQuery({ text: "Задача уже недоступна" });
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(await this.taskCard(access.workspaceId, context), { reply_markup: taskDetailKeyboard(id, context.occurrence.status) }).catch(() => undefined);
      return;
    }
    const task = await this.tasks.getTask(access.workspaceId, id);
    if (!task || task.status !== "active" || task.timeMode !== "fuzzy") return ctx.answerCallbackQuery({ text: "Задача уже недоступна" });
    await ctx.answerCallbackQuery();
    const extras = await this.tasks.getTaskCardExtras(access.workspaceId, task.id).catch(() => ({ checklist: [], goalTitle: null }));
    await ctx.editMessageText(fuzzyTaskCardText({ ...task, ...extras }), { reply_markup: fuzzyTaskDetailKeyboard() }).catch(() => undefined);
  }

  private async applyReschedule(
    access: NonNullable<Awaited<ReturnType<AccessService["resolveActiveUser"]>>>,
    occurrenceId: string,
    schedule: RescheduleFields,
    reason?: string,
  ) {
    const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
    if (!context) throw new Error("occurrence not found");
    const action: ProposedActionDraft = {
      type: "reschedule_occurrence",
      source: "user_explicit",
      confidence: 1,
      occurrenceId,
      expectedVersion: context.occurrence.version,
      reason: reason ?? null,
      schedule: {
        timezone: context.occurrence.timezone,
        plannedStartAt: schedule.plannedStartAt ? formatIsoInstantInTimezone(schedule.plannedStartAt, context.occurrence.timezone) : null,
        plannedEndAt: schedule.plannedEndAt ? formatIsoInstantInTimezone(schedule.plannedEndAt, context.occurrence.timezone) : null,
        plannedLocalDate: schedule.plannedLocalDate ?? null,
        dueAt: schedule.dueAt ? formatIsoInstantInTimezone(schedule.dueAt, context.occurrence.timezone) : null,
        dueLocalDate: schedule.dueLocalDate ?? null,
        fuzzyHorizonText: schedule.fuzzyHorizonText ?? null,
        reviewAt: schedule.reviewAt ? formatIsoInstantInTimezone(schedule.reviewAt, context.occurrence.timezone) : null,
      },
    };
    const errors = await this.actions.validate([action], { workspaceId: access.workspaceId, actorUserId: access.user.id, recipientUserId: access.user.id });
    if (errors.length) throw new Error(errors.join("; "));
    return this.actions.handleProposed([action], { workspaceId: access.workspaceId, actorUserId: access.user.id, recipientUserId: access.user.id });
  }

  private registerTextHandler(): void {
    this.telegram.bot.on("message:text", async (ctx) => {
      if (ctx.message.text.startsWith("/")) return;
      const access = await this.access.resolveActiveUser(ctx.from.id);
      if (!access) return ctx.reply("Этот бот закрыт. Доступ выдаётся владельцем проекта.");
      const settings = await this.settings.get(access.user.id);
      if (!settings) return ctx.reply("Не найдены настройки пользователя.");

      if (isUntilMorningPhrase(ctx.message.text)) {
        const until = await this.settings.snoozeUntilMorning(access.user.id);
        await ctx.reply(`Хорошо. Молчу до ${formatLocal(until, settings.timezone)}.`);
        return;
      }

      const pending = await this.settings.consumePendingInput(access.user.id);
      if (pending) {
        await this.handlePendingInput(ctx, access, settings.timezone, pending);
        return;
      }

      const conversationControl = detectConversationControl(ctx.message.text);
      if (conversationControl === "end") {
        const ended = await this.chat.endConversation(access.workspaceId, access.user.id);
        await ctx.reply(ended ? "Обсуждение закончено. Ничего нового не сохранено." : "Сейчас нет активного разбора.");
        return;
      }
      if (conversationControl === "conclude") {
        const result = await this.chat.concludeConversation({
          workspaceId: access.workspaceId, userId: access.user.id, aiStatus: access.user.aiStatus, timezone: settings.timezone, language: settings.pinnedLanguage,
        });
        await this.chatReply.reply(ctx, access, result);
        return;
      }

      try {
        const result = await this.chat.processText({
          workspaceId: access.workspaceId,
          userId: access.user.id,
          aiStatus: access.user.aiStatus,
          timezone: settings.timezone,
          language: settings.pinnedLanguage,
          text: ctx.message.text,
          telegramChatId: ctx.chat.id,
          telegramMessageId: ctx.message.message_id,
        });
        await this.chatReply.reply(ctx, access, result);
      } catch (error) {
        console.error("text processing failed", { userId: access.user.id, messageId: ctx.message.message_id, message: safeMessageMetadata(ctx.message.text), error: safeError(error) });
        const text = error instanceof ActionStateUncertainError
          ? "AI понял запрос, но сервис не смог подтвердить итог записи. Не повторяй команду сейчас: состояние будет сверено после восстановления."
          : "Не удалось обработать сообщение. Новое действие не подтверждено; можно повторить запрос позже.";
        await ctx.reply(text).catch(() => undefined);
      }
    });
  }

  private async handleDigestCommand(ctx: any, kind: "morning" | "evening"): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return;
    const parts = commandArgs(ctx.message.text).split(/\s+/u).filter(Boolean);
    if (!parts.length) {
      const settings = await this.settings.get(access.user.id);
      if (!settings) return ctx.reply("Не найдены настройки пользователя.");
      const now = new Date();
      const briefing = await this.briefings.build({
        workspaceId: access.workspaceId,
        kind,
        localDate: localDateAt(now, settings.timezone),
        timezone: settings.timezone,
        now,
      });
      await ctx.reply(briefing.text);
      return;
    }
    const enabled = parts[0] === "on";
    if ((enabled && parts.length !== 2) || (!enabled && (parts[0] !== "off" || parts.length !== 1))) {
      await ctx.reply(`Сводка сейчас: /${kind}\nНастройка: /${kind} on <HH:MM> или /${kind} off`);
      return;
    }
    try {
      await this.settings.setDigest({ userId: access.user.id, kind, enabled, ...(enabled ? { time: parts[1]! } : {}) });
      await ctx.reply(enabled ? `${kind === "morning" ? "Утренняя" : "Вечерняя"} сводка включена.` : "Сводка выключена.");
    } catch {
      await ctx.reply("Неверное время. Используй HH:MM.");
    }
  }

  private async handleTopicControlCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const match = TOPIC_CONTROL_CALLBACK.exec(ctx.callbackQuery.data);
    const operation = match?.[1] as "continue" | "conclude" | "end" | undefined;
    const topicId = match?.[2];
    if (!operation || !topicId) return ctx.answerCallbackQuery({ text: "Некорректная команда" });

    if (operation === "continue") {
      await ctx.answerCallbackQuery({ text: "Продолжаем" });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
      return;
    }
    if (operation === "end") {
      const ended = await this.chat.endConversation(access.workspaceId, access.user.id, topicId);
      await ctx.answerCallbackQuery({ text: ended ? "Закончено" : "Уже завершено" });
      const currentText = ctx.callbackQuery.message?.text as string | undefined;
      if (ended && currentText?.startsWith("💭 Вечерний разбор")) {
        const body = currentText.split("\n").slice(2).join("\n").trim();
        await ctx.editMessageText(`💭 Вечерний разбор · завершён${body ? `\n\n${body}` : ""}`, { reply_markup: new InlineKeyboard() }).catch(() => undefined);
      } else {
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
      }
      return;
    }

    const settings = await this.settings.get(access.user.id);
    if (!settings) return ctx.answerCallbackQuery({ text: "Настройки не найдены" });
    await ctx.answerCallbackQuery({ text: "Делаю вывод" }).catch(() => undefined);
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    const result = await this.chat.concludeConversation({
      workspaceId: access.workspaceId, userId: access.user.id, aiStatus: access.user.aiStatus, timezone: settings.timezone, language: settings.pinnedLanguage, topicId,
    });
    await this.chatReply.reply(ctx, access, result);
  }

  private async handleReminderCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const deliveryId = REMINDER_CALLBACK.exec(ctx.callbackQuery.data)?.[1];
    if (!deliveryId) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
    try {
      const cancelled = await this.reminders.cancelUpcoming({ workspaceId: access.workspaceId, userId: access.user.id, deliveryId });
      await ctx.answerCallbackQuery({ text: cancelled ? "Напоминание отменено" : "Оно уже отправлено или отменено" });
      if (cancelled) await this.replyReminders(ctx, access.workspaceId, access.user.id, true);
    } catch (error) {
      console.error("reminder cancellation failed", { deliveryId, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: "Не удалось отменить напоминание" }).catch(() => undefined);
    }
  }

  private async handleActionCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const match = ACTION_CALLBACK.exec(ctx.callbackQuery.data);
    const action = match?.[1]; const groupId = match?.[2];
    if (!action || !groupId) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
    try {
      if (action === "confirm") {
        const result = await this.actions.confirm(access.workspaceId, access.user.id, access.user.id, groupId);
        await ctx.answerCallbackQuery({ text: result.count === 1 ? "Подтверждено ✓" : `Подтверждено: ${result.count}` }).catch(() => undefined);
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
        // The confirmation toast disappears; the persisted outcome deserves a message of its own, with Undo attached to it.
        const report = result.items?.length ? renderAppliedReport(result.items, new Date()) : "";
        await ctx.reply(report ? `Подтверждено.\n\n${report}` : "Подтверждено.", { reply_markup: undoKeyboard(groupId) }).catch(() => undefined);
        return;
      }
      if (action === "cancel") {
        const cancelled = await this.actions.cancel(access.workspaceId, access.user.id, groupId);
        await ctx.answerCallbackQuery({ text: cancelled ? "Отменено" : "Уже обработано" }).catch(() => undefined);
        if (cancelled) await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
        return;
      }
      await this.actions.undo(access.workspaceId, access.user.id, groupId);
      await ctx.answerCallbackQuery({ text: "Изменение отменено" }).catch(() => undefined);
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    } catch (error) {
      console.error("action callback failed", { action, groupId, error: safeError(error) });
      const text = error instanceof ActionStateUncertainError ? "Состояние сохранено и будет сверено после восстановления сервиса" : "Действие устарело или уже изменено";
      await ctx.answerCallbackQuery({ text }).catch(() => undefined);
    }
  }

  private async handleHistoryClearCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const count = await this.chat.clearConversation(access.workspaceId, access.user.id);
    const locale = await this.localeFor(ctx, access.user.id);
    await ctx.answerCallbackQuery({ text: aiHistoryClearedNotice(locale, count) }).catch(() => undefined);
    if (ctx.callbackQuery.message?.text?.startsWith("⚙️ Настройки")) {
      await this.replySettings(ctx, access.workspaceId, access.user.id, true);
      return;
    }
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
  }

  private async handleOccurrenceCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const match = OCCURRENCE_CALLBACK.exec(ctx.callbackQuery.data);
    const action = match?.[1]; const occurrenceId = match?.[2];
    if (!action || !occurrenceId) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
    try {
      const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
      if (!context) return ctx.answerCallbackQuery({ text: "Задача не найдена" });

      if (action === "more") {
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: taskMoreKeyboard(occurrenceId, context.occurrence.status, Boolean(context.task.recurrenceRule), context.task.id) }).catch(() => undefined);
        return;
      }
      if (action === "back") {
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: context.occurrence.status === "in_progress" ? startedTaskKeyboard(occurrenceId) : taskKeyboard(occurrenceId, context.occurrence.status) }).catch(() => undefined);
        return;
      }
      if (action === "check") {
        if (context.occurrence.status !== "in_progress") return ctx.answerCallbackQuery({ text: "Задача уже не в работе" });
        await ctx.answerCallbackQuery({ text: "Когда проверить результат?" });
        await ctx.editMessageReplyMarkup({ reply_markup: resultCheckKeyboard(occurrenceId) }).catch(() => undefined);
        return;
      }
      if (action === "resched") {
        await ctx.answerCallbackQuery({ text: "Когда вернуться?" });
        await ctx.editMessageReplyMarkup({ reply_markup: quickRescheduleKeyboard(occurrenceId) }).catch(() => undefined);
        return;
      }
      if (action === "seen") {
        await this.tasks.recordInteraction({ workspaceId: access.workspaceId, occurrenceId, actorUserId: access.user.id, eventType: "occurrence:seen" });
        await this.reminders.scheduleSeenFallback({ workspaceId: access.workspaceId, userId: access.user.id, occurrenceId });
        await ctx.answerCallbackQuery({ text: "Вернусь к задаче позже" });
        await ctx.editMessageReplyMarkup({ reply_markup: taskKeyboard(occurrenceId, context.occurrence.status) }).catch(() => undefined);
        return;
      }
      if (action === "cant") {
        await this.tasks.recordInteraction({ workspaceId: access.workspaceId, occurrenceId, actorUserId: access.user.id, eventType: "occurrence:cant_start" });
        await this.settings.setPendingInput(access.user.id, { kind: "blocker", occurrenceId });
        await ctx.answerCallbackQuery({ text: "Расскажи, что мешает" });
        await ctx.editMessageText(`🧱 ${context.task.title}\n\nЧто мешает начать? Напиши одним сообщением.`, {
          reply_markup: new InlineKeyboard().text("🕒 Перенести", `occ:resched:${occurrenceId}`).text("❌ Отменить", `occ:cancel:${occurrenceId}`),
        }).catch(() => undefined);
        return;
      }
      if (action === "cancel" && context.task.recurrenceRule) {
        await ctx.answerCallbackQuery({ text: "Что отменить?" });
        await ctx.editMessageReplyMarkup({
          reply_markup: new InlineKeyboard()
            .text("Только это", `occ:cancel_one:${occurrenceId}`)
            .text("Всю серию", `series:cancel:${context.task.id}`)
            .row()
            .text("← Назад", `occ:back:${occurrenceId}`),
        }).catch(() => undefined);
        return;
      }

      const nextStatus = action === "start" ? "in_progress" : action === "done" ? "done" : action === "skip" ? "skipped" : "cancelled";
      await this.tasks.setOccurrenceStatus({
        workspaceId: access.workspaceId,
        occurrenceId,
        expectedVersion: context.occurrence.version,
        nextStatus,
        actorUserId: access.user.id,
      });
      const now = new Date();
      await ctx.answerCallbackQuery({ text: action === "start" ? "Начато" : action === "done" ? "Готово ✓" : action === "skip" ? "Пропущено" : "Отменено" });
      if (action === "start") {
        const current = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
        if (current) await ctx.editMessageText(await this.taskCard(access.workspaceId, current), { reply_markup: startedTaskKeyboard(occurrenceId) }).catch(() => undefined);
        return;
      }
      await ctx.editMessageText(terminalTaskText(context.task, action === "done" ? "done" : action === "skip" ? "skipped" : "cancelled", now), {
        reply_markup: new InlineKeyboard(),
      }).catch(() => ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined));
    } catch (error) {
      console.error("occurrence callback failed", { action, occurrenceId, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: "Состояние уже изменилось или действие недоступно" }).catch(() => undefined);
    }
  }

  private async buildQuickReschedule(
    access: NonNullable<Awaited<ReturnType<AccessService["resolveActiveUser"]>>>,
    occurrenceId: string,
    choice: QuickRescheduleChoice,
  ): Promise<RescheduleFields> {
    const [context, settings] = await Promise.all([
      this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId),
      this.settings.get(access.user.id),
    ]);
    if (!context) throw new Error("occurrence not found");
    if (!settings) throw new Error("settings missing");
    return quickRescheduleSchedule({
      choice,
      timeMode: context.task.timeMode,
      occurrence: context.occurrence,
      now: new Date(),
      morningReferenceTime: settings.morningReferenceTime,
      eveningReferenceTime: settings.eveningReferenceTime,
    });
  }

  private async completeQuickReschedule(
    ctx: any,
    access: NonNullable<Awaited<ReturnType<AccessService["resolveActiveUser"]>>>,
    occurrenceId: string,
    choice: QuickRescheduleChoice,
    reason?: string,
  ): Promise<void> {
    const schedule = await this.buildQuickReschedule(access, occurrenceId, choice);
    const result = await this.applyReschedule(access, occurrenceId, schedule, reason);
    const current = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
    await ctx.answerCallbackQuery({ text: "Перенесено" }).catch(() => undefined);
    if (current) {
      const keyboard = current.occurrence.status === "in_progress" ? startedTaskKeyboard(occurrenceId) : taskKeyboard(occurrenceId, current.occurrence.status);
      if (result.applied) keyboard.row().text("↩️ Отменить перенос", `act:undo:${result.applied.groupId}`);
      await ctx.editMessageText(await this.taskCard(access.workspaceId, current), { reply_markup: keyboard }).catch(() => undefined);
    }
  }

  private async handleQuickRescheduleCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const match = QUICK_RESCHEDULE_CALLBACK.exec(ctx.callbackQuery.data);
    const choice = match?.[1] as QuickRescheduleChoice | "custom" | undefined;
    const occurrenceId = match?.[2];
    if (!choice || !occurrenceId) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
    const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
    if (!context) return ctx.answerCallbackQuery({ text: "Задача не найдена" });
    if (choice === "custom") {
      await this.settings.setPendingInput(access.user.id, { kind: "reschedule", occurrenceId });
      await ctx.answerCallbackQuery({ text: "Напиши новое время" });
      await ctx.editMessageText(`🕒 ${context.task.title}\n\n${reschedulePrompt(context.task.timeMode)}`, {
        reply_markup: new InlineKeyboard().text("← Назад", `occ:back:${occurrenceId}`),
      }).catch(() => undefined);
      return;
    }
    try {
      if (await this.tasks.isRescheduleReasonRequired(access.workspaceId, occurrenceId)) {
        await ctx.answerCallbackQuery({ text: "Почему переносишь?" });
        await ctx.editMessageReplyMarkup({ reply_markup: quickRescheduleReasonKeyboard(occurrenceId, choice) }).catch(() => undefined);
        return;
      }
      await this.completeQuickReschedule(ctx, access, occurrenceId, choice);
    } catch (error) {
      console.error("quick reschedule failed", { occurrenceId, choice, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: "Не удалось перенести" }).catch(() => undefined);
    }
  }

  private async handleQuickRescheduleReasonCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const match = QUICK_RESCHEDULE_REASON_CALLBACK.exec(ctx.callbackQuery.data);
    const choice = quickChoiceFromCode(match?.[1]);
    const code = quickReasonFromCode(match?.[2]);
    const occurrenceId = match?.[3];
    if (!choice || !code || !occurrenceId) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
    if (code === "other") {
      await this.settings.setPendingInput(access.user.id, { kind: "quick_reschedule_reason", occurrenceId, choice });
      const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
      await ctx.answerCallbackQuery({ text: "Напиши причину" });
      if (context) {
        await ctx.editMessageText(`🕒 ${context.task.title}\n\nПочему переносишь? Напиши коротко одним сообщением.`, {
          reply_markup: new InlineKeyboard().text("← Назад", `occ:resched:${occurrenceId}`),
        }).catch(() => undefined);
      }
      return;
    }
    try {
      const reason = quickRescheduleReasonText(code);
      if (!reason) throw new Error("reason missing");
      await this.completeQuickReschedule(ctx, access, occurrenceId, choice, reason);
    } catch (error) {
      console.error("quick reschedule reason failed", { occurrenceId, choice, code, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: "Не удалось перенести" }).catch(() => undefined);
    }
  }

  private async handleFollowUpCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const match = FOLLOW_UP_CALLBACK.exec(ctx.callbackQuery.data);
    const mode = match?.[1] as "seen" | "result" | undefined;
    const choice = match?.[2] as "15m" | "1h" | "evening" | "custom" | "none" | undefined;
    const occurrenceId = match?.[3];
    if (!mode || !choice || !occurrenceId) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
    try {
      if (choice === "none") {
        if (mode !== "result") return ctx.answerCallbackQuery({ text: "Некорректная команда" });
        await ctx.answerCallbackQuery({ text: "Проверки не будет" });
        await ctx.editMessageReplyMarkup({ reply_markup: startedTaskKeyboard(occurrenceId) }).catch(() => undefined);
        return;
      }
      if (choice === "custom") {
        await this.settings.setPendingInput(access.user.id, { kind: "follow_up_custom", occurrenceId, mode });
        await ctx.answerCallbackQuery({ text: "Напиши время" });
        await ctx.reply("Напиши: количество минут (минимум 15), HH:MM или YYYY-MM-DD HH:MM.");
        return;
      }
      await this.reminders.scheduleFollowUpChoice({ workspaceId: access.workspaceId, userId: access.user.id, occurrenceId, choice, mode });
      await ctx.answerCallbackQuery({ text: "Обновлено" });
      await ctx.editMessageReplyMarkup({ reply_markup: startedTaskKeyboard(occurrenceId) }).catch(() => undefined);
    } catch (error) {
      console.error("follow-up callback failed", { occurrenceId, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: "Не удалось изменить проверку" }).catch(() => undefined);
    }
  }

  private async handleSeriesCallback(ctx: any): Promise<void> {
    const access = await this.access.resolveActiveUser(ctx.from.id);
    if (!access) return ctx.answerCallbackQuery({ text: "Нет доступа" });
    const match = SERIES_CALLBACK.exec(ctx.callbackQuery.data);
    const operation = match?.[1] as "pause" | "cancel" | undefined;
    const taskId = match?.[2];
    if (!operation || !taskId) return ctx.answerCallbackQuery({ text: "Некорректная команда" });
    const task = await this.tasks.getTask(access.workspaceId, taskId);
    if (!task) return ctx.answerCallbackQuery({ text: "Серия не найдена" });
    try {
      const action: ProposedActionDraft = { type: "change_series", source: "user_explicit", confidence: 1, taskId, expectedVersion: task.version, operation, edit: null };
      const result = await this.actions.handleProposed([action], { workspaceId: access.workspaceId, actorUserId: access.user.id, recipientUserId: access.user.id });
      const message = operation === "pause" ? "Серия на паузе" : "Серия отменена";
      await ctx.answerCallbackQuery({ text: message });
      if (result.applied) await ctx.reply(`${message}.`, { reply_markup: undoKeyboard(result.applied.groupId) });
    } catch (error) {
      console.error("series callback failed", { taskId, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: "Серия уже изменилась" }).catch(() => undefined);
    }
  }

  private async handlePendingInput(ctx: any, access: NonNullable<Awaited<ReturnType<AccessService["resolveActiveUser"]>>>, timezone: string, pending: PendingInput): Promise<void> {
    try {
      if (pending.kind === "quick_reschedule_reason") {
        const reason = ctx.message.text.trim();
        if (reason.length < 2) throw new Error("reschedule reason is too short");
        const schedule = await this.buildQuickReschedule(access, pending.occurrenceId, pending.choice);
        const result = await this.applyReschedule(access, pending.occurrenceId, schedule, reason);
        const current = await this.tasks.getOccurrenceContext(access.workspaceId, pending.occurrenceId);
        if (current) {
          const keyboard = taskKeyboard(pending.occurrenceId, current.occurrence.status);
          if (result.applied) keyboard.row().text("↩️ Отменить перенос", `act:undo:${result.applied.groupId}`);
          await ctx.reply(await this.taskCard(access.workspaceId, current), { reply_markup: keyboard });
        } else {
          await ctx.reply("Перенесено.");
        }
        return;
      }
      if (pending.kind === "blocker") {
        await this.tasks.recordBlocker({ workspaceId: access.workspaceId, occurrenceId: pending.occurrenceId, actorUserId: access.user.id, details: ctx.message.text });
        const currentSettings = await this.settings.get(access.user.id);
        if (!currentSettings) throw new Error("settings missing");
        const result = await this.chat.processText({
          workspaceId: access.workspaceId, userId: access.user.id, aiStatus: access.user.aiStatus, timezone: currentSettings.timezone, language: currentSettings.pinnedLanguage ?? ctx.from?.language_code ?? null,
          text: ctx.message.text, telegramChatId: ctx.chat.id, telegramMessageId: ctx.message.message_id,
        });
        await this.chatReply.reply(ctx, access, result);
        return;
      }
      if (pending.kind === "follow_up_custom") {
        const intendedFor = parseCustomFollowUpInput(ctx.message.text, timezone, new Date());
        await this.reminders.scheduleCustomFollowUp({ workspaceId: access.workspaceId, userId: access.user.id, occurrenceId: pending.occurrenceId, intendedFor, mode: pending.mode });
        await ctx.reply(`Готово. Проверю ${formatLocal(intendedFor, timezone)}.`);
        return;
      }

      const context = await this.tasks.getOccurrenceContext(access.workspaceId, pending.occurrenceId);
      if (!context) throw new Error("occurrence not found");
      const parsed = parseRescheduleInput(ctx.message.text, context.task.timeMode, timezone);
      const action: ProposedActionDraft = {
        type: "reschedule_occurrence",
        source: "user_explicit",
        confidence: 1,
        occurrenceId: pending.occurrenceId,
        expectedVersion: context.occurrence.version,
        reason: parsed.reason ?? null,
        schedule: {
          timezone: context.occurrence.timezone,
          plannedStartAt: parsed.schedule.plannedStartAt ? formatIsoInstantInTimezone(parsed.schedule.plannedStartAt, context.occurrence.timezone) : null,
          plannedEndAt: parsed.schedule.plannedEndAt ? formatIsoInstantInTimezone(parsed.schedule.plannedEndAt, context.occurrence.timezone) : null,
          plannedLocalDate: parsed.schedule.plannedLocalDate ?? null,
          dueAt: parsed.schedule.dueAt ? formatIsoInstantInTimezone(parsed.schedule.dueAt, context.occurrence.timezone) : null,
          dueLocalDate: parsed.schedule.dueLocalDate ?? null,
          fuzzyHorizonText: parsed.schedule.fuzzyHorizonText ?? null,
          reviewAt: parsed.schedule.reviewAt ? formatIsoInstantInTimezone(parsed.schedule.reviewAt, context.occurrence.timezone) : null,
        },
      };
      const errors = await this.actions.validate([action], { workspaceId: access.workspaceId, actorUserId: access.user.id, recipientUserId: access.user.id });
      if (errors.length) throw new Error(errors.join("; "));
      const result = await this.actions.handleProposed([action], { workspaceId: access.workspaceId, actorUserId: access.user.id, recipientUserId: access.user.id });
      const keyboard = result.applied ? undoKeyboard(result.applied.groupId) : undefined;
      const report = result.applied?.items?.length ? renderAppliedReport(result.applied.items, new Date()) : "";
      const headline = parsed.schedule.fuzzyHorizonText ? "Вернул задачу в нечёткое планирование." : "Перенесено.";
      await ctx.reply(report ? `${headline}\n\n${report}` : headline, keyboard ? { reply_markup: keyboard } : {});
      if (!parsed.schedule.fuzzyHorizonText) {
        const count = await this.tasks.countOccurrenceEvents(access.workspaceId, pending.occurrenceId, "occurrence:rescheduled");
        if (count >= 2) {
          await ctx.reply("Это уже повторный перенос. Если проблема не только во времени, можно зафиксировать, что именно мешает начать.", {
            reply_markup: new InlineKeyboard().text("Не могу начать", `occ:cant:${pending.occurrenceId}`).text("Начал", `occ:start:${pending.occurrenceId}`),
          });
        }
      }
    } catch (error) {
      console.warn("pending input handling failed", { userId: access.user.id, kind: pending.kind, error: safeError(error) });
      if (pending.kind === "blocker") {
        await ctx.reply("Не удалось продолжить AI-разбор сейчас. Описание препятствия сохранено; если сообщение ждёт AI, его можно повторить через /retry_ai.");
        return;
      }
      await this.settings.setPendingInput(access.user.id, pending);
      if (pending.kind === "quick_reschedule_reason") {
        await ctx.reply("Не удалось перенести. Напиши коротко, почему переносишь, ещё раз.");
        return;
      }
      const message = pending.kind === "reschedule" ? `Не удалось перенести. Проверь формат.\n${reschedulePrompt((await this.tasks.getOccurrenceContext(access.workspaceId, pending.occurrenceId))?.task.timeMode ?? "point")}` : "Не понял время. Напиши минуты, HH:MM или YYYY-MM-DD HH:MM.";
      await ctx.reply(message);
    }
  }

}

function undoKeyboard(groupId: string): InlineKeyboard {
  return new InlineKeyboard().text("Отменить изменение", `act:undo:${groupId}`);
}

function quickChoiceFromCode(value?: string): QuickRescheduleChoice | undefined {
  return value === "h" ? "1h" : value === "e" ? "evening" : value === "t" ? "tomorrow" : undefined;
}
function quickReasonFromCode(value?: string): QuickRescheduleReasonCode | undefined {
  return value === "t" ? "time" : value === "d" ? "dependency" : value === "e" ? "energy" : value === "o" ? "other" : undefined;
}

function commandArgs(text: string): string { return text.replace(/^\/\S+(?:@\S+)?\s*/u, "").trim(); }
type GuideSection = "tasks" | "goals" | "reminders" | "reports" | "ai";
type GuideDestination = GuideSection | "help" | "index";

function helpKeyboard(locale: TelegramLocale): InlineKeyboard {
  const label = locale === "en" ? "📖 How it works" : locale === "uk" ? "📖 Як це працює" : "📖 Как это работает";
  return new InlineKeyboard().text(label, "guide:index");
}

function guideKeyboard(locale: TelegramLocale, current?: GuideSection): InlineKeyboard {
  const labels = locale === "en"
    ? { tasks: "Tasks", goals: "Goals", reminders: "Reminders", reports: "Reports", ai: "AI processing", back: "← Help" }
    : locale === "uk"
      ? { tasks: "Завдання", goals: "Цілі", reminders: "Нагадування", reports: "Огляди", ai: "AI-обробка", back: "← Допомога" }
      : { tasks: "Задачи", goals: "Цели", reminders: "Напоминания", reports: "Отчёты", ai: "AI-обработка", back: "← Помощь" };
  if (current) return new InlineKeyboard().text(labels.back, "guide:index");
  return new InlineKeyboard()
    .text(labels.tasks, "guide:tasks").text(labels.goals, "guide:goals").row()
    .text(labels.reminders, "guide:reminders").text(labels.reports, "guide:reports").row()
    .text(labels.ai, "guide:ai");
}

function guideIndexText(locale: TelegramLocale): string {
  if (locale === "en") return "📖 How it works\n\nChoose a topic. These guides explain behaviour and boundaries; manage everything by writing naturally in chat.";
  if (locale === "uk") return "📖 Як це працює\n\nОбери тему. Ці сторінки пояснюють логіку та межі; керувати всім можна звичайними повідомленнями в чаті.";
  return "📖 Как это работает\n\nВыбери тему. Эти страницы объясняют логику и границы; управлять всем можно обычными сообщениями в чате.";
}

export function guideText(section: GuideSection, locale: TelegramLocale): string {
  const ru: Record<GuideSection, string> = {
    tasks: "📋 Задачи\n\nЗадача может быть точной по времени, с окном, с дедлайном или с примерным горизонтом. Сразу добавляй «зачем», ограничения, людей, материалы и следующий шаг — это контекст задачи. Он попадёт в планирование и еженедельный обзор.\n\nЕсли дело состоит из шагов, перечисли их: AI предложит чек-лист. Незакрытые пункты не отмечаются автоматически при выполнении задачи. Для повторяющихся задач можно задать несколько времён в день.",
    goals: "🎯 Цели\n\nЦель отвечает на «зачем»: она связывает задачи и помогает выбирать, чему уделить внимание. У неё можно менять название, формулировку «зачем» и контекст обычным сообщением.\n\nСвязанные задачи показываются в /goals. На еженедельном обзоре AI обсуждает прогресс и помогает спланировать следующую неделю — без скрытых автоматических изменений.",
    reminders: "🔔 Напоминания\n\nДля события приходят сообщения до начала и в момент старта. Задача с точным временем напоминается в запланированный момент. У важных дедлайнов есть дополнительные планировочные касания до и около срока.\n\nТихие часы и перенос учитываются. Любое напоминание можно отменить или перенести обычным сообщением; новое напоминание не создаётся в прошлом.",
    reports: "🗓 Отчёты и обзоры\n\nУтренний обзор собирает план дня. Вечерний помогает коротко подвести итог и решить, что перенести. Еженедельный обзор — разговор о целях, привычках, блокерах и плане следующей недели.\n\nНастрой время утреннего, вечернего и еженедельного обзора в /settings обычным сообщением. Обзор не создаёт и не меняет задачи без понятного согласования.",
    ai: "🤖 AI-обработка\n\nAI читает только ограниченный релевантный контекст твоего личного workspace: текущий диалог, задачи, цели и несекретный профиль. Он не получает данные других пользователей, доступ к базе или ключам.\n\nНе присылай пароли и ключи. Для внешней AI-обработки требуется согласие; голосовое сначала расшифровывается, аудио не сохраняется. «Очистить AI-историю» удаляет только историю, используемую AI, а не задачи, цели или профиль.",
  };
  if (locale === "ru") return ru[section];
  const uk: Record<GuideSection, string> = {
    tasks: "📋 Завдання\n\nЗавдання може мати точний час, проміжок, дедлайн або приблизний горизонт. Одразу додавай «навіщо», обмеження, людей, матеріали й наступний крок — це контекст завдання для планування та щотижневого огляду.\n\nЯкщо справа складається з кроків, переліч їх: AI запропонує чекліст. Незакриті пункти не відмічаються автоматично разом із завданням. Для повторюваних завдань можна задати кілька часів на день.",
    goals: "🎯 Цілі\n\nЦіль відповідає на «навіщо»: вона пов'язує завдання й допомагає обирати пріоритет. Назву, «навіщо» та контекст можна змінювати звичайним повідомленням.\n\nПов'язані завдання видно в /goals. На щотижневому огляді AI обговорює прогрес і допомагає спланувати наступний тиждень — без прихованих автоматичних змін.",
    reminders: "🔔 Нагадування\n\nДля події приходять повідомлення до початку й у момент старту. Завдання з точним часом нагадується у запланований момент. Важливі дедлайни мають додаткові планувальні нагадування до та біля строку.\n\nТихі години й перенесення враховуються. Будь-яке нагадування можна скасувати або перенести звичайним повідомленням; минуле не створюється.",
    reports: "🗓 Зведення й огляди\n\nРанкове зведення збирає план дня. Вечірнє допомагає коротко підбити підсумок і вирішити, що перенести. Щотижневий огляд — розмова про цілі, звички, блокери й план наступного тижня.\n\nЧас ранкового, вечірнього та щотижневого огляду змінюється в /settings звичайним повідомленням. Огляд не створює й не змінює завдання без зрозумілого погодження.",
    ai: "🤖 AI-обробка\n\nAI бачить лише обмежений релевантний контекст твого особистого workspace: поточний діалог, завдання, цілі та несекретний профіль. Він не отримує дані інших користувачів, доступ до бази чи ключів.\n\nНе надсилай паролі та ключі. Для зовнішньої AI-обробки потрібна згода; голосове спершу розшифровується, аудіо не зберігається. «Очистити AI-історію» видаляє лише історію для AI, а не завдання, цілі чи профіль.",
  };
  const en: Record<GuideSection, string> = {
    tasks: "📋 Tasks\n\nA task can have an exact time, time window, deadline, or deliberately approximate horizon. Include why it matters, constraints, people, materials, and a next step — that becomes task context for planning and the weekly review.\n\nFor a multi-step job, list the steps and AI can propose a checklist. Unchecked items are never silently completed with the task. Recurring tasks can have several times per day.",
    goals: "🎯 Goals\n\nA goal answers “why”: it connects related tasks and helps choose priorities. You can change its title, why, and context in an ordinary message.\n\nLinked tasks appear in /goals. During the weekly review, AI discusses progress and helps plan the next week — without hidden automatic changes.",
    reminders: "🔔 Reminders\n\nAn event is contacted before it starts and at the start. A task with an exact time is contacted at its planned time. Important deadlines receive additional planning contacts before and around the due date.\n\nQuiet hours and rescheduling are respected. Cancel or move any reminder in a normal message; a reminder is never created in the past.",
    reports: "🗓 Briefings and reviews\n\nThe morning briefing gathers the day's plan. The evening review helps close the day and decide what to move. The weekly review is a conversation about goals, habits, blockers, and the next week's plan.\n\nChange morning, evening, and weekly review times in /settings using ordinary language. A review never creates or changes tasks without clear agreement.",
    ai: "🤖 AI processing\n\nAI receives only limited relevant context from your personal workspace: the current conversation, tasks, goals, and non-sensitive profile. It cannot access other users' data, the database, or credentials.\n\nDo not send passwords or access keys. External AI processing requires consent; voice is transcribed first and audio is not stored. “Clear AI history” removes only history used by AI, not tasks, goals, or your profile.",
  };
  return locale === "uk" ? uk[section] : en[section];
}

export function registrationTokenFromStart(text: string): string | null {
  return commandArgs(text).match(/^join_([A-Za-z0-9_-]{32,64})$/u)?.[1] ?? null;
}
export function canCreateRegistrationInvite(ownerTelegramUserId: number | undefined, telegramUserId: number): boolean {
  return ownerTelegramUserId !== undefined && ownerTelegramUserId === telegramUserId;
}
function registrationDeniedText(locale: TelegramLocale): string {
  if (locale === "en") return "This bot is private. Ask an existing user for a personal invitation link.";
  if (locale === "uk") return "Цей бот приватний. Попроси в користувача персональне посилання-запрошення.";
  return "Этот бот закрытый. Попроси у пользователя персональную ссылку-приглашение.";
}
function registrationInviteInvalidText(locale: TelegramLocale): string {
  if (locale === "en") return "This invitation link is invalid, expired, or has already been used.";
  if (locale === "uk") return "Це посилання-запрошення недійсне, прострочене або вже використане.";
  return "Эта ссылка-приглашение недействительна, просрочена или уже использована.";
}
function registrationInviteCreatedText(locale: TelegramLocale, link: string): string {
  if (locale === "en") return `Send this personal link to a new user:\n${link}\n\nIt works once for 7 days. They will get a separate workspace and will not see your data.`;
  if (locale === "uk") return `Надішли це персональне посилання новому користувачу:\n${link}\n\nВоно діє один раз протягом 7 днів. У людини буде окремий простір без доступу до твоїх даних.`;
  return `Отправь эту персональную ссылку новому пользователю:\n${link}\n\nОна действует один раз в течение 7 дней. У человека будет отдельное пространство без доступа к твоим данным.`;
}
function registrationInviteNotAllowedText(locale: TelegramLocale): string {
  if (locale === "en") return "Only the project owner can create invitation links.";
  if (locale === "uk") return "Створювати посилання-запрошення може лише власник проєкту.";
  return "Создавать ссылки-приглашения может только владелец проекта.";
}
function registrationInviteFailedText(locale: TelegramLocale): string {
  if (locale === "en") return "Could not create an invitation link. Please try again later.";
  if (locale === "uk") return "Не вдалося створити посилання-запрошення. Спробуй пізніше.";
  return "Не удалось создать ссылку-приглашение. Попробуй позже.";
}
function aiHistoryClearedText(locale: TelegramLocale, count: number): string {
  if (locale === "en") return `AI history cleared (${count} messages). Telegram messages, tasks, goals, reminders, and settings are unchanged.`;
  if (locale === "uk") return `AI-історію очищено (${count} повідомлень). Повідомлення Telegram, завдання, цілі, нагадування й налаштування не змінені.`;
  return `AI-история очищена (${count} сообщений). Сообщения Telegram, задачи, цели, напоминания и настройки не изменены.`;
}
function aiHistoryClearedNotice(locale: TelegramLocale, count: number): string {
  if (locale === "en") return `AI history cleared (${count})`;
  if (locale === "uk") return `AI-історію очищено (${count})`;
  return `AI-история очищена (${count})`;
}
function isUntilMorningPhrase(text: string): boolean { return /(?:замолчи|мовчи|не пиши(?: мне)?)\s+до\s+(?:утра|ранку)|до\s+(?:утра|ранку).*(?:замолчи|мовчи|не пиши)/iu.test(text.trim()); }
function formatLocal(at: Date, timezone: string): string { return formatLocalDateTime(at, timezone, new Date()); }
function reschedulePrompt(mode: string): string {
  if (mode === "window") return "Новое окно: YYYY-MM-DD HH:MM-HH:MM. Причину можно добавить после |";
  if (mode === "deadline") return "Новый срок: YYYY-MM-DD или YYYY-MM-DD HH:MM. Для разовой задачи можно вернуть нечёткий горизонт: примерно: <горизонт> @ YYYY-MM-DD HH:MM. Причину можно добавить после |";
  return "Новое время: YYYY-MM-DD HH:MM. Для разовой задачи можно вернуть нечёткий горизонт: примерно: <горизонт> @ YYYY-MM-DD HH:MM. Причину можно добавить после |";
}

export function helpText(config: AppConfig, locale: TelegramLocale): string {
  const voiceMb = Math.floor(config.aiVoiceMaxBytes / (1024 * 1024));
  if (locale === "en") return [
    "IPsycho, in short",
    "",
    "Write naturally or send a voice message — commands are not needed to create tasks. I help you remember, plan, and return to what matters without adding bureaucracy.",
    "",
    "What you can write",
    "• “Remind me to call the doctor tomorrow at 16:00”",
    "• “Move ‘buy pet food’ to Friday”",
    "• “I want to prepare for a half marathon by October”",
    "• “For the presentation, it is important to align the numbers with Lena”",
    "• “Do not message me until morning” or “weekly review on Sunday at 18:00”",
    "",
    "View and manage",
    "• /today — today’s plan",
    "• /tasks or /task — all active tasks",
    "• /goals — goals and linked tasks",
    "• /reminders — upcoming reminders",
    "• /settings — notification and chat settings",
    "• /context — what is useful to know about you",
    "• /status — whether the bot, database, and AI are available",
    "",
    "Use the button below for details about tasks, goals, reminders, reports, and AI processing.",
    "Relative time uses your timezone; unclear or sensitive changes need confirmation. /clear removes only AI history.",
    "Do not send passwords or access keys in chat.",
    `Limits: ${config.aiMaxMessagesPerHour} messages / ${config.aiMaxCallsPerHour} AI calls per hour; voice up to ${Math.floor(config.aiVoiceMaxDurationSeconds / 60)} min and ${voiceMb} MB.`,
  ].join("\n");
  if (locale === "uk") return [
    "IPsycho — коротко",
    "",
    "Пиши як людині або надсилай голосове повідомлення — команди для створення завдань не потрібні. Я допомагаю пам'ятати, планувати й повертатися до важливого без зайвої бюрократії.",
    "",
    "Що можна написати",
    "• «Нагадай завтра о 16:00 зателефонувати лікарю»",
    "• «Перенеси “купити корм” на п'ятницю»",
    "• «Хочу підготуватися до напівмарафону до жовтня»",
    "• «У презентації важливо узгодити цифри з Леною»",
    "• «Не пиши до ранку» або «щотижневий огляд у неділю о 18:00»",
    "",
    "Перегляд і керування",
    "• /today — план на сьогодні",
    "• /tasks або /task — усі активні завдання",
    "• /goals — цілі та пов'язані завдання",
    "• /reminders — найближчі нагадування",
    "• /settings — налаштування повідомлень і чату",
    "• /context — що корисно враховувати про тебе",
    "• /status — чи доступні бот, база та AI",
    "",
    "Кнопка нижче відкриє деталі про завдання, цілі, нагадування, огляди та AI-обробку.",
    "Відносний час рахується у твоєму поясі; неочевидні або чутливі зміни потребують підтвердження. /clear очищає лише AI-історію.",
    "Не надсилай у чат паролі чи ключі доступу.",
    `Ліміти: ${config.aiMaxMessagesPerHour} повідомлень / ${config.aiMaxCallsPerHour} AI-звернень за годину; голосове до ${Math.floor(config.aiVoiceMaxDurationSeconds / 60)} хв і ${voiceMb} МБ.`,
  ].join("\n");
  return [
    "IPsycho — коротко",
    "",
    "Пиши как человеку или отправляй голосовое сообщение — команды для создания задач не нужны. Я помогаю помнить, планировать и возвращаться к важному без лишней бюрократии.",
    "",
    "Что можно написать",
    "• «Напомни завтра в 16:00 позвонить врачу»",
    "• «Перенеси “купить корм” на пятницу»",
    "• «Хочу подготовиться к полумарафону к октябрю»",
    "• «В презентации важно согласовать цифры с Леной»",
    "• «Не пиши до утра» или «еженедельный обзор в воскресенье в 18:00»",
    "",
    "Просмотр и управление",
    "• /today — план на сегодня",
    "• /tasks или /task — все активные задачи",
    "• /goals — цели и связанные задачи",
    "• /reminders — ближайшие напоминания",
    "• /settings — настройки уведомлений и чата",
    "• /context — что полезно учитывать о тебе",
    "• /status — доступны ли бот, база и AI",
    "",
    "Кнопка ниже откроет подробности о задачах, целях, напоминаниях, отчётах и AI-обработке.",
    "Относительное время считается в твоём часовом поясе; неочевидные и чувствительные изменения требуют подтверждения. /clear очищает только AI-историю.",
    "Не отправляй в чат пароли или ключи доступа.",
    `Лимиты: ${config.aiMaxMessagesPerHour} сообщений / ${config.aiMaxCallsPerHour} AI-обращений за час; голосовое до ${Math.floor(config.aiVoiceMaxDurationSeconds / 60)} мин и ${voiceMb} МБ.`,
  ].join("\n");
}

export function deterministicCopy(locale: TelegramLocale) {
  if (locale === "en") return {
    startOnboarding: "Hi, I’m IPsycho — a personal assistant for tasks and plans. Write naturally: I can save a task, remind you, or break a goal into steps.\n\nLet’s set the rhythm of notifications first. Would you like morning and evening briefings? The default times are 09:00 and 20:00; you can change everything later.",
    ready: "Hi — I help you remember, plan, and follow through on what matters.\n\nWrite naturally or send a voice message. For example: “Remind me to call the doctor tomorrow at 16:00” or “I want to prepare for a half marathon by October”.\n\nYour plan: /today · tasks: /tasks · goals: /goals\nFull guide: /help.",
    yes: "Yes", no: "No", ping: "Check connection", defaultLabel: "Use defaults", off: "Turn off", saved: "Saved", done: "Done",
    quietPrompt: "Turn on quiet hours? Defaults: weekdays 22:00–08:00, weekends 23:00–09:00.",
    weeklyPrompt: "Would you like a weekly review of goals and habits every Sunday at 20:00?",
    onboardingDone: "Setup is complete. Write naturally. You can change everything later in /settings.",
  };
  return locale === "uk" ? {
    startOnboarding: "Привіт, я IPsycho — особистий помічник для справ і планів. Пиши звичайними словами: я допоможу зберегти задачу, нагадати або розкласти мету на кроки.\n\nСпочатку налаштуємо ритм повідомлень. Потрібні ранкове й вечірнє зведення? Типовий час — 09:00 і 20:00; усе можна змінити пізніше.",
    ready: "Привіт — я допомагаю пам'ятати, планувати й доводити важливе до результату.\n\nПиши як людині або надсилай голосове повідомлення. Наприклад: «нагадай завтра о 16:00 зателефонувати лікарю» або «хочу підготуватися до напівмарафону до жовтня».\n\nПлан: /today · завдання: /tasks · цілі: /goals\nПовний гід: /help.",
    yes: "Так", no: "Ні", ping: "Перевірити зв’язок", defaultLabel: "За замовчуванням", off: "Вимкнути", saved: "Збережено", done: "Готово",
    quietPrompt: "Увімкнути тихі години? За замовчуванням: будні 22:00–08:00, вихідні 23:00–09:00.",
    weeklyPrompt: "Потрібен тижневий огляд цілей і звичок щонеділі о 20:00?",
    onboardingDone: "Налаштування завершено. Пиши звичайним текстом. Усе можна змінити через /settings і команди з нього.",
  } : {
    startOnboarding: "Привет, я IPsycho — личный помощник для дел и планов. Пиши обычными словами: я помогу сохранить задачу, напомнить или разложить цель на шаги.\n\nСначала настроим ритм сообщений. Нужны утренняя и вечерняя сводки? Обычное время — 09:00 и 20:00; всё можно изменить позже.",
    ready: "Привет — я помогаю помнить, планировать и доводить важное до результата.\n\nПиши как человеку или отправляй голосовое сообщение. Например: «напомни завтра в 16:00 позвонить врачу» или «хочу подготовиться к полумарафону к октябрю».\n\nПлан: /today · задачи: /tasks · цели: /goals\nПолный гид: /help.",
    yes: "Да", no: "Нет", ping: "Проверить связь", defaultLabel: "По умолчанию", off: "Выключить", saved: "Сохранено", done: "Готово",
    quietPrompt: "Включить тихие часы? По умолчанию: будни 22:00–08:00, выходные 23:00–09:00.",
    weeklyPrompt: "Нужен недельный обзор целей и привычек по воскресеньям в 20:00?",
    onboardingDone: "Настройка завершена. Пиши обычным текстом. Всё можно изменить через /settings и команды из него.",
  };
}
