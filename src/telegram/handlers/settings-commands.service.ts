import { Injectable } from "@nestjs/common";
import { InlineKeyboard, type Bot, type CallbackQueryContext, type CommandContext } from "grammy";
import { ActionsService } from "../../actions/actions.service.js";
import { BriefingContentService } from "../../briefings/briefing-content.service.js";
import { ChatService } from "../../chat/chat.service.js";
import type { ResolvedActionOf } from "../../core/ai-contract.js";
import { renderAppliedReport } from "../../core/applied-report.js";
import { isDomainRuleError } from "../../core/errors.js";
import { DEFAULT_QUIET_HOURS } from "../../core/settings-change.js";
import { formatLocalDateTime } from "../../core/time-presentation.js";
import { localDateAt, localDateTimeAt } from "../../core/timezone.js";
import { resolveTimezoneInput } from "../../core/timezone-lookup.js";
import { safeError } from "../../observability/safe-error.js";
import { SettingsService } from "../../settings/settings.service.js";
import { t } from "../copy/index.js";
import { TelegramChatReplyService } from "../telegram-chat-reply.service.js";
import { activeState, type AppContext } from "../telegram-context.js";
import { ScreensService } from "./screens.service.js";
import { logger } from "../../observability/logger.js";

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
    private readonly actions: ActionsService,
  ) {}

  /**
   * A settings command is the same change the model would propose, so it takes the same road:
   * one journaled action with Undo, validated by the same rules. Returns false when the
   * change was refused (the user already got the reason).
   */
  private async applySettings(
    ctx: AppContext,
    operation: SettingsFields["operation"],
    fields: Partial<Omit<SettingsFields, "operation">>,
    doneKey: Parameters<typeof t>[1] | null,
  ): Promise<boolean> {
    const { access, settings, locale } = activeState(ctx);
    const action: ResolvedActionOf<"settings"> = {
      type: "settings",
      intent: "explicit",
      timezone: settings.timezone,
      reviewTime: settings.morningReferenceTime,
      expectedVersion: settings.version,
      operation,
      applyTimezoneTo: null,
      language: null,
      digestKind: null,
      enabled: null,
      time: null,
      weekday: null,
      weekdayStart: null,
      weekdayEnd: null,
      weekendStart: null,
      weekendEnd: null,
      snoozeUntilDate: null,
      snoozeUntilTime: null,
      eventOffsets: null,
      plannedTaskOffsetMinutes: null,
      criticalPostDueMinutes: null,
      seenNormalMinutes: null,
      seenRequiredMinutes: null,
      seenCriticalMinutes: null,
      ...fields,
    };
    const scope = {
      workspaceId: access.workspaceId,
      actorUserId: access.user.id,
      recipientUserId: access.user.id,
      language: settings.pinnedLanguage ?? ctx.from?.language_code ?? null,
    };
    try {
      const issues = await this.actions.validateResolved([action], scope);
      if (issues.length) {
        await ctx.reply(t(locale, "rd_failed"));
        return false;
      }
      const applied = await this.actions.applyResolved([action], scope);
      const report = applied.items?.length ? renderAppliedReport(applied.items, new Date(), locale) : "";
      const text = doneKey ? `${t(locale, doneKey)}${report ? `\n\n${report}` : ""}` : report;
      await ctx.reply(text || t(locale, "saved_toast"), { reply_markup: new InlineKeyboard().text(t(locale, "undo_button"), `act:undo:${applied.groupId}`) });
      const updated = await this.settings.get(access.user.id);
      if (updated) ctx.state = { ...ctx.state, settings: updated };
      return true;
    } catch (error) {
      if (!isDomainRuleError(error)) throw error;
      logger.warn("settings command refused", { userId: access.user.id, operation, error: safeError(error) });
      await ctx.reply(t(locale, error.code === "time_invalid" ? "time_invalid" : "rd_failed"));
      return false;
    }
  }

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
    const { locale } = activeState(ctx);
    const value = commandArgs(ctx.msg.text ?? "");
    if (!value) return void (await ctx.reply(t(locale, "timezone_usage")));
    const zone = resolveTimezoneInput(value);
    if (!zone) return void (await ctx.reply(t(locale, "timezone_invalid")));
    if (!(await this.applySettings(ctx, "timezone", { timezone: zone, applyTimezoneTo: "profile_only" }, null))) return;
    await ctx.reply(t(locale, "timezone_set", { timezone: zone }), {
      reply_markup: new InlineKeyboard()
        .text(t(locale, "tz_apply_both"), "tzapply:both")
        .text(t(locale, "tz_keep"), "tzapply:keep")
        .row()
        .text(t(locale, "tz_apply_digests"), "tzapply:digests")
        .text(t(locale, "tz_apply_quiet"), "tzapply:quiet"),
    });
  }

  private async language(ctx: CommandContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const value = commandArgs(ctx.msg.text ?? "").trim();
    const automatic = value.toLowerCase() === "auto";
    if (!value || (!automatic && !/^[a-z]{2}(?:-[a-z]{2})?$/iu.test(value))) return void (await ctx.reply(t(locale, "language_usage")));
    await this.applySettings(ctx, "language", { language: automatic ? null : value }, automatic ? "language_auto" : null);
  }

  private async digest(ctx: CommandContext<AppContext>, kind: "morning" | "evening"): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const parts = commandArgs(ctx.msg.text ?? "")
      .split(/\s+/u)
      .filter(Boolean);
    if (!parts.length) {
      const now = new Date();
      const briefing = await this.briefings.build({
        workspaceId: access.workspaceId,
        kind,
        localDate: localDateAt(now, settings.timezone),
        timezone: settings.timezone,
        now,
        locale,
      });
      await ctx.reply(briefing.text);
      return;
    }
    const enabled = parts[0] === "on";
    if ((enabled && parts.length !== 2) || (!enabled && (parts[0] !== "off" || parts.length !== 1))) return void (await ctx.reply(t(locale, "digest_usage", { kind })));
    await this.applySettings(
      ctx,
      "digest",
      { digestKind: kind, enabled, time: enabled ? parts[1]! : null },
      enabled ? (kind === "morning" ? "digest_on_morning" : "digest_on_evening") : "digest_off",
    );
  }

  private async weekly(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const parts = commandArgs(ctx.msg.text ?? "")
      .split(/\s+/u)
      .filter(Boolean);
    if (!parts.length) {
      const now = new Date();
      const briefing = await this.briefings.build({
        workspaceId: access.workspaceId,
        kind: "weekly",
        localDate: localDateAt(now, settings.timezone),
        timezone: settings.timezone,
        now,
        locale,
      });
      await ctx.reply(briefing.text);
      return;
    }
    if (parts[0] === "review") {
      const result = await this.chat.startReview({
        workspaceId: access.workspaceId,
        userId: access.user.id,
        aiStatus: access.user.aiStatus,
        timezone: settings.timezone,
        digestTimezone: settings.digestTimezone,
        language: settings.pinnedLanguage,
        kind: "weekly",
      });
      await this.chatReply.reply(ctx, access, result);
      return;
    }
    const enabled = parts[0] === "on";
    if ((enabled && parts.length !== 3) || (!enabled && (parts[0] !== "off" || parts.length !== 1))) return void (await ctx.reply(t(locale, "weekly_usage")));
    const weekday = enabled ? Number(parts[1]) : null;
    if (enabled && (!Number.isInteger(weekday) || weekday! < 1 || weekday! > 7)) return void (await ctx.reply(t(locale, "weekly_invalid")));
    await this.applySettings(ctx, "weekly_review", { enabled, weekday, time: enabled ? parts[2]! : null }, enabled ? "weekly_on" : "weekly_off");
  }

  private async quiet(ctx: CommandContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const parts = commandArgs(ctx.msg.text ?? "")
      .split(/\s+/u)
      .filter(Boolean);
    if (!parts.length || parts[0] === "default") {
      await this.applySettings(ctx, "quiet_hours", { enabled: true, ...DEFAULT_QUIET_HOURS }, "quiet_default");
      return;
    }
    if (parts[0] === "off") {
      await this.applySettings(ctx, "quiet_hours", { enabled: false }, "quiet_off");
      return;
    }
    const [weekdayStart, weekdayEnd, weekendStart, weekendEnd] = parts;
    if (parts.length === 4 && weekdayStart && weekdayEnd && weekendStart && weekendEnd) {
      await this.applySettings(ctx, "quiet_hours", { enabled: true, weekdayStart, weekdayEnd, weekendStart, weekendEnd }, "quiet_updated");
      return;
    }
    await ctx.reply(t(locale, "quiet_usage"));
  }

  private async snooze(ctx: CommandContext<AppContext>): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const value = commandArgs(ctx.msg.text ?? "").toLowerCase();
    if (value === "off") {
      await this.applySettings(ctx, "snooze", { snoozeUntilDate: null, snoozeUntilTime: null }, "snooze_off");
      return;
    }
    let until: Date;
    if (value === "morning" || value === "утро" || value === "ранок") {
      until = await this.settings.snoozeUntilMorning(access.user.id);
      const updated = await this.settings.get(access.user.id);
      if (updated) ctx.state = { ...ctx.state, settings: updated };
      await ctx.reply(t(locale, "snooze_until", { until: formatLocalDateTime(until, settings.timezone, new Date()) }));
      return;
    }
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 7 * 24 * 60) return void (await ctx.reply(t(locale, "snooze_usage")));
    until = new Date(Date.now() + minutes * 60_000);
    const local = localDateTimeAt(until, settings.timezone);
    const pad = (n: number) => String(n).padStart(2, "0");
    const applied = await this.applySettings(
      ctx,
      "snooze",
      { snoozeUntilDate: `${local.year}-${pad(local.month)}-${pad(local.day)}`, snoozeUntilTime: `${pad(local.hour)}:${pad(local.minute)}` },
      null,
    );
    if (applied) await ctx.reply(t(locale, "snooze_until", { until: formatLocalDateTime(until, settings.timezone, new Date()) }));
  }

  private async reminderDefaults(ctx: CommandContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const parts = commandArgs(ctx.msg.text ?? "")
      .split(/\s+/u)
      .filter(Boolean);
    if (parts[0] === "seen" && parts.length === 4) {
      await this.applySettings(
        ctx,
        "reminder_defaults",
        { seenNormalMinutes: Number(parts[1]), seenRequiredMinutes: Number(parts[2]), seenCriticalMinutes: Number(parts[3]) },
        "rd_seen",
      );
      return;
    }
    if (parts[0] === "event" && parts[1]) {
      const offsets = parts[1].split(",").map(Number);
      const sorted = [...offsets].sort((a, b) => a - b);
      const dense = sorted.some((value, index) => index > 0 && value - sorted[index - 1]! < 15);
      const applied = await this.applySettings(ctx, "reminder_defaults", { eventOffsets: offsets }, null);
      if (applied && (offsets.length > 8 || dense)) await ctx.reply(t(locale, "rd_event_warning").trim());
      return;
    }
    if (parts[0] === "task" && parts[1]) {
      await this.applySettings(ctx, "reminder_defaults", { plannedTaskOffsetMinutes: Number(parts[1]) }, "rd_task");
      return;
    }
    if (parts[0] === "critical" && parts[1]) {
      await this.applySettings(ctx, "reminder_defaults", { criticalPostDueMinutes: Number(parts[1]) }, "rd_critical");
      return;
    }
    await ctx.reply(t(locale, "rd_usage"));
  }

  private async applyTimezone(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const target = TIMEZONE_APPLY_CALLBACK.exec(ctx.callbackQuery.data)?.[1] as "digests" | "quiet" | "both" | "keep" | undefined;
    if (!target) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    if (target !== "keep") await this.settings.applyProfileTimezone(access.user.id, target);
    await ctx.answerCallbackQuery({ text: t(locale, target === "keep" ? "saved_toast" : "tz_applied_toast") });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
  }

  private async prefs(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const match = PREFS_CALLBACK.exec(ctx.callbackQuery.data);
    const key = match?.[1];
    const action = match?.[2];
    if (!key || !action) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    try {
      if (key === "morning") await this.settings.setDigest({ userId: access.user.id, kind: "morning", enabled: !settings.morningDigestEnabled });
      else if (key === "evening") await this.settings.setDigest({ userId: access.user.id, kind: "evening", enabled: !settings.eveningDigestEnabled });
      else if (key === "weekly") await this.settings.setWeekly({ userId: access.user.id, enabled: !settings.weeklyReviewEnabled });
      else if (key === "quiet")
        await this.settings.setQuietHours(access.user.id, {
          enabled: !settings.quietHoursEnabled,
          ...(settings.quietHoursEnabled
            ? {}
            : { weekdayStart: settings.weekdayQuietStart, weekdayEnd: settings.weekdayQuietEnd, weekendStart: settings.weekendQuietStart, weekendEnd: settings.weekendQuietEnd }),
        });
      else if (key === "snooze" && action === "morning") await this.settings.snoozeUntilMorning(access.user.id);
      const updated = await this.settings.get(access.user.id);
      if (!updated) throw new Error("settings missing after update");
      ctx.state = { ...ctx.state, settings: updated };
      await ctx.answerCallbackQuery({ text: t(locale, key === "snooze" ? "prefs_snooze_toast" : "saved_toast") });
      await this.screens.settings_(ctx, true);
    } catch (error) {
      logger.error("settings callback failed", { userId: access.user.id, key, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: t(locale, "prefs_failed_toast") }).catch(() => undefined);
    }
  }
}

export function commandArgs(text: string): string {
  return text.replace(/^\/\S+(?:@\S+)?\s*/u, "").trim();
}

type SettingsFields = ResolvedActionOf<"settings">;
