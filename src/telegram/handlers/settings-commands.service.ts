import { Injectable } from "@nestjs/common";
import { InlineKeyboard, type Bot, type CallbackQueryContext, type CommandContext } from "grammy";
import { BriefingContentService } from "../../briefings/briefing-content.service.js";
import { ChatService } from "../../chat/chat.service.js";
import { formatLocalDateTime } from "../../core/time-presentation.js";
import { localDateAt } from "../../core/timezone.js";
import { resolveTimezoneInput } from "../../core/timezone-lookup.js";
import { safeError } from "../../observability/safe-error.js";
import { SettingsService } from "../../settings/settings.service.js";
import { t } from "../copy/index.js";
import { TelegramChatReplyService } from "../telegram-chat-reply.service.js";
import { activeState, type AppContext } from "../telegram-context.js";
import { ScreensService } from "./screens.service.js";

const TIMEZONE_APPLY_CALLBACK = /^tzapply:(digests|quiet|both|keep)$/;
const PREFS_CALLBACK = /^prefs:(morning|evening|weekly|quiet|snooze):(toggle|morning)$/;

/** Deterministic settings commands: they never go through the model and always answer in the user's language. */
@Injectable()
export class SettingsCommandsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly briefings: BriefingContentService,
    private readonly chat: ChatService,
    private readonly chatReply: TelegramChatReplyService,
    private readonly screens: ScreensService,
  ) {}

  register(bot: Bot<AppContext>): void {
    bot.command("timezone", (ctx) => this.timezone(ctx));
    bot.command("language", (ctx) => this.language(ctx));
    bot.command("morning", (ctx) => this.digest(ctx, "morning"));
    bot.command("evening", (ctx) => this.digest(ctx, "evening"));
    bot.command("weekly", (ctx) => this.weekly(ctx));
    bot.command("quiet", (ctx) => this.quiet(ctx));
    bot.command("snooze", (ctx) => this.snooze(ctx));
    bot.command("reminder_defaults", (ctx) => this.reminderDefaults(ctx));
    bot.callbackQuery(TIMEZONE_APPLY_CALLBACK, (ctx) => this.applyTimezone(ctx));
    bot.callbackQuery(PREFS_CALLBACK, (ctx) => this.prefs(ctx));
  }

  private async timezone(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const value = commandArgs(ctx.msg.text ?? "");
    if (!value) return void await ctx.reply(t(locale, "timezone_usage"));
    const zone = resolveTimezoneInput(value);
    if (!zone) return void await ctx.reply(t(locale, "timezone_invalid"));
    await this.settings.setTimezone(access.user.id, zone);
    await ctx.reply(t(locale, "timezone_set", { timezone: zone }), {
      reply_markup: new InlineKeyboard()
        .text(t(locale, "tz_apply_both"), "tzapply:both").text(t(locale, "tz_keep"), "tzapply:keep").row()
        .text(t(locale, "tz_apply_digests"), "tzapply:digests").text(t(locale, "tz_apply_quiet"), "tzapply:quiet"),
    });
  }

  private async language(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const value = commandArgs(ctx.msg.text ?? "").trim();
    try {
      const automatic = value.toLowerCase() === "auto";
      const normalized = await this.settings.setLanguage(access.user.id, automatic ? null : value);
      await ctx.reply(automatic ? t(locale, "language_auto") : t(locale, "language_set", { language: normalized ?? "" }));
    } catch {
      await ctx.reply(t(locale, "language_usage"));
    }
  }

  private async digest(ctx: CommandContext<AppContext>, kind: "morning" | "evening"): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const parts = commandArgs(ctx.msg.text ?? "").split(/\s+/u).filter(Boolean);
    if (!parts.length) {
      const now = new Date();
      const briefing = await this.briefings.build({ workspaceId: access.workspaceId, kind, localDate: localDateAt(now, settings.timezone), timezone: settings.timezone, now, locale });
      await ctx.reply(briefing.text);
      return;
    }
    const enabled = parts[0] === "on";
    if ((enabled && parts.length !== 2) || (!enabled && (parts[0] !== "off" || parts.length !== 1))) return void await ctx.reply(t(locale, "digest_usage", { kind }));
    try {
      await this.settings.setDigest({ userId: access.user.id, kind, enabled, ...(enabled ? { time: parts[1]! } : {}) });
      await ctx.reply(t(locale, enabled ? (kind === "morning" ? "digest_on_morning" : "digest_on_evening") : "digest_off"));
    } catch (error) {
      console.warn("digest settings update failed", { userId: access.user.id, error: safeError(error) });
      await ctx.reply(t(locale, "time_invalid"));
    }
  }

  private async weekly(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const parts = commandArgs(ctx.msg.text ?? "").split(/\s+/u).filter(Boolean);
    if (!parts.length) {
      const now = new Date();
      const briefing = await this.briefings.build({ workspaceId: access.workspaceId, kind: "weekly", localDate: localDateAt(now, settings.timezone), timezone: settings.timezone, now, locale });
      await ctx.reply(briefing.text);
      return;
    }
    if (parts[0] === "review") {
      const result = await this.chat.startReview({
        workspaceId: access.workspaceId, userId: access.user.id, aiStatus: access.user.aiStatus,
        timezone: settings.timezone, digestTimezone: settings.digestTimezone, language: settings.pinnedLanguage, kind: "weekly",
      });
      await this.chatReply.reply(ctx, access, result);
      return;
    }
    const enabled = parts[0] === "on";
    if ((enabled && parts.length !== 3) || (!enabled && (parts[0] !== "off" || parts.length !== 1))) return void await ctx.reply(t(locale, "weekly_usage"));
    try {
      await this.settings.setWeekly({ userId: access.user.id, enabled, ...(enabled ? { weekday: Number(parts[1]), time: parts[2]! } : {}) });
      await ctx.reply(t(locale, enabled ? "weekly_on" : "weekly_off"));
    } catch (error) {
      console.warn("weekly settings update failed", { userId: access.user.id, error: safeError(error) });
      await ctx.reply(t(locale, "weekly_invalid"));
    }
  }

  private async quiet(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const parts = commandArgs(ctx.msg.text ?? "").split(/\s+/u).filter(Boolean);
    try {
      if (!parts.length || parts[0] === "default") {
        await this.settings.setQuietHours(access.user.id, { enabled: true, weekdayStart: "22:00", weekdayEnd: "08:00", weekendStart: "23:00", weekendEnd: "09:00" });
        return void await ctx.reply(t(locale, "quiet_default"));
      }
      if (parts[0] === "off") {
        await this.settings.setQuietHours(access.user.id, { enabled: false });
        return void await ctx.reply(t(locale, "quiet_off"));
      }
      const [weekdayStart, weekdayEnd, weekendStart, weekendEnd] = parts;
      if (parts.length === 4 && weekdayStart && weekdayEnd && weekendStart && weekendEnd) {
        await this.settings.setQuietHours(access.user.id, { enabled: true, weekdayStart, weekdayEnd, weekendStart, weekendEnd });
        return void await ctx.reply(t(locale, "quiet_updated"));
      }
      await ctx.reply(t(locale, "quiet_usage"));
    } catch (error) {
      console.warn("quiet hours update failed", { userId: access.user.id, error: safeError(error) });
      await ctx.reply(t(locale, "time_invalid"));
    }
  }

  private async snooze(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const value = commandArgs(ctx.msg.text ?? "").toLowerCase();
    try {
      if (value === "off") {
        await this.settings.snoozeUntil(access.user.id, null);
        return void await ctx.reply(t(locale, "snooze_off"));
      }
      if (value === "morning" || value === "утро" || value === "ранок") {
        const until = await this.settings.snoozeUntilMorning(access.user.id);
        return void await ctx.reply(t(locale, "snooze_until", { until: formatLocalDateTime(until, settings.timezone, new Date()) }));
      }
      const minutes = Number(value);
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 7 * 24 * 60) return void await ctx.reply(t(locale, "snooze_usage"));
      const until = new Date(Date.now() + minutes * 60_000);
      await this.settings.snoozeUntil(access.user.id, until);
      await ctx.reply(t(locale, "snooze_until", { until: formatLocalDateTime(until, settings.timezone, new Date()) }));
    } catch (error) {
      console.warn("snooze update failed", { userId: access.user.id, error: safeError(error) });
      await ctx.reply(t(locale, "snooze_failed"));
    }
  }

  private async reminderDefaults(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const parts = commandArgs(ctx.msg.text ?? "").split(/\s+/u).filter(Boolean);
    try {
      if (parts[0] === "seen" && parts.length === 4) {
        await this.settings.setReminderDefaults({ userId: access.user.id, seenNormalMinutes: Number(parts[1]), seenRequiredMinutes: Number(parts[2]), seenCriticalMinutes: Number(parts[3]) });
        return void await ctx.reply(t(locale, "rd_seen"));
      }
      if (parts[0] === "event" && parts[1]) {
        const offsets = parts[1].split(",").map(Number);
        await this.settings.setReminderDefaults({ userId: access.user.id, eventOffsets: offsets });
        const sorted = [...offsets].sort((a, b) => a - b);
        const dense = sorted.some((value, index) => index > 0 && value - sorted[index - 1]! < 15);
        return void await ctx.reply(t(locale, "rd_event", { warning: offsets.length > 8 || dense ? t(locale, "rd_event_warning") : "" }));
      }
      if (parts[0] === "task" && parts[1]) {
        await this.settings.setReminderDefaults({ userId: access.user.id, plannedTaskOffsetMinutes: Number(parts[1]) });
        return void await ctx.reply(t(locale, "rd_task"));
      }
      if (parts[0] === "critical" && parts[1]) {
        await this.settings.setReminderDefaults({ userId: access.user.id, criticalPostDueMinutes: Number(parts[1]) });
        return void await ctx.reply(t(locale, "rd_critical"));
      }
      await ctx.reply(t(locale, "rd_usage"));
    } catch (error) {
      console.warn("reminder defaults update failed", { userId: access.user.id, error: safeError(error) });
      await ctx.reply(t(locale, "rd_failed"));
    }
  }

  private async applyTimezone(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const target = TIMEZONE_APPLY_CALLBACK.exec(ctx.callbackQuery.data)?.[1] as "digests" | "quiet" | "both" | "keep" | undefined;
    if (!target) return void await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") });
    if (target !== "keep") await this.settings.applyProfileTimezone(access.user.id, target);
    await ctx.answerCallbackQuery({ text: t(locale, target === "keep" ? "saved_toast" : "tz_applied_toast") });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
  }

  private async prefs(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const match = PREFS_CALLBACK.exec(ctx.callbackQuery.data);
    const key = match?.[1];
    const action = match?.[2];
    if (!key || !action) return void await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") });
    try {
      if (key === "morning") await this.settings.setDigest({ userId: access.user.id, kind: "morning", enabled: !settings.morningDigestEnabled });
      else if (key === "evening") await this.settings.setDigest({ userId: access.user.id, kind: "evening", enabled: !settings.eveningDigestEnabled });
      else if (key === "weekly") await this.settings.setWeekly({ userId: access.user.id, enabled: !settings.weeklyReviewEnabled });
      else if (key === "quiet") await this.settings.setQuietHours(access.user.id, { enabled: !settings.quietHoursEnabled });
      else if (key === "snooze" && action === "morning") await this.settings.snoozeUntilMorning(access.user.id);
      const updated = await this.settings.get(access.user.id);
      if (!updated) throw new Error("settings missing after update");
      ctx.state = { ...ctx.state, settings: updated };
      await ctx.answerCallbackQuery({ text: t(locale, key === "snooze" ? "prefs_snooze_toast" : "saved_toast") });
      await this.screens.settings_(ctx, true);
    } catch (error) {
      console.error("settings callback failed", { userId: access.user.id, key, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: t(locale, "prefs_failed_toast") }).catch(() => undefined);
    }
  }
}

export function commandArgs(text: string): string {
  return text.replace(/^\/\S+(?:@\S+)?\s*/u, "").trim();
}
