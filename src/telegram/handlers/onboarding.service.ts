import { Injectable } from "@nestjs/common";
import { InlineKeyboard, type Bot, type CallbackQueryContext } from "grammy";
import { TIMEZONE_SUGGESTIONS, resolveTimezoneInput } from "../../core/timezone-lookup.js";
import { SettingsService } from "../../settings/settings.service.js";
import { t } from "../copy/index.js";
import { deterministicCopy } from "../copy/onboarding.js";
import { activeState, type AppContext } from "../telegram-context.js";
import { ScreensService } from "./screens.service.js";

const ONBOARD_CALLBACK = /^onb:(tz|digests|quiet|weekly):([A-Za-z_/+-]+|on|off|default|other)$/;

/**
 * First run: timezone, then digests, quiet hours and the weekly review, each one tap. The
 * timezone comes first because every other time in the product is read in it; the old flow
 * never asked and silently used Kyiv for everyone.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly settings: SettingsService, private readonly screens: ScreensService) {}

  register(bot: Bot<AppContext>): void {
    bot.callbackQuery(ONBOARD_CALLBACK, (ctx) => this.step(ctx));
  }

  async begin(ctx: AppContext): Promise<void> {
    const { locale } = activeState(ctx);
    await ctx.reply(deterministicCopy(locale).startOnboarding);
    await this.askTimezone(ctx);
  }

  async askTimezone(ctx: AppContext): Promise<void> {
    const { locale } = activeState(ctx);
    const keyboard = new InlineKeyboard();
    for (const zone of TIMEZONE_SUGGESTIONS) keyboard.text(zone, `onb:tz:${zone}`).row();
    keyboard.text(t(locale, "onb_timezone_other"), "onb:tz:other");
    await ctx.reply(t(locale, "onb_timezone_prompt"), { reply_markup: keyboard });
  }

  /** Free text typed after "Other": a city or a zone name. Returns false when it did not resolve. */
  async applyTypedTimezone(ctx: AppContext, text: string, onboarding: boolean): Promise<boolean> {
    const { access, locale } = activeState(ctx);
    const zone = resolveTimezoneInput(text);
    if (!zone) {
      await this.settings.setPendingInput(access.user.id, { kind: "timezone", onboarding });
      await ctx.reply(t(locale, "timezone_invalid"));
      return false;
    }
    await this.settings.setTimezone(access.user.id, zone, { applyTo: "both" });
    if (onboarding) await this.askDigests(ctx);
    else await ctx.reply(t(locale, "timezone_set", { timezone: zone }));
    return true;
  }

  private async askDigests(ctx: AppContext): Promise<void> {
    const copy = deterministicCopy(activeState(ctx).locale);
    await ctx.reply(copy.digestsPrompt, { reply_markup: new InlineKeyboard().text(copy.yes, "onb:digests:on").text(copy.no, "onb:digests:off") });
  }

  private async step(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const match = ONBOARD_CALLBACK.exec(ctx.callbackQuery.data);
    const step = match?.[1];
    const value = match?.[2];
    if (!step || !value) return void await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") });
    const copy = deterministicCopy(locale);
    const stripButtons = () => ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);

    if (step === "tz") {
      if (value === "other") {
        await this.settings.setPendingInput(access.user.id, { kind: "timezone", onboarding: true });
        await ctx.answerCallbackQuery({ text: t(locale, "timezone_usage").split("\n")[0] ?? "" });
        await stripButtons();
        return;
      }
      const zone = resolveTimezoneInput(value);
      if (!zone) return void await ctx.answerCallbackQuery({ text: t(locale, "timezone_invalid") });
      await this.settings.setTimezone(access.user.id, zone, { applyTo: "both" });
      await ctx.answerCallbackQuery({ text: t(locale, "onb_timezone_saved_toast") });
      await stripButtons();
      await this.askDigests(ctx);
      return;
    }
    if (step === "digests") {
      await this.settings.setDigestPreset(access.user.id, value === "on");
      await ctx.answerCallbackQuery({ text: copy.saved });
      await stripButtons();
      await ctx.reply(copy.quietPrompt, { reply_markup: new InlineKeyboard().text(copy.defaultLabel, "onb:quiet:default").text(copy.off, "onb:quiet:off") });
      return;
    }
    if (step === "quiet") {
      await this.settings.setQuietHours(access.user.id, value === "off" ? { enabled: false } : { enabled: true, weekdayStart: "22:00", weekdayEnd: "08:00", weekendStart: "23:00", weekendEnd: "09:00" });
      await ctx.answerCallbackQuery({ text: copy.saved });
      await stripButtons();
      await ctx.reply(copy.weeklyPrompt, { reply_markup: new InlineKeyboard().text(copy.yes, "onb:weekly:on").text(copy.no, "onb:weekly:off") });
      return;
    }
    await this.settings.setWeeklyPreset(access.user.id, value === "on");
    await this.settings.completeOnboarding(access.user.id);
    await ctx.answerCallbackQuery({ text: copy.done });
    await stripButtons();
    await ctx.reply(copy.onboardingDone);
    // The three answers are visible and editable in one place, instead of a bare "done".
    const settings = await this.settings.get(access.user.id);
    if (settings) ctx.state = { ...ctx.state, settings };
    await this.screens.settings_(ctx);
  }
}
