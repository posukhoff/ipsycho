import { Injectable } from "@nestjs/common";
import { InlineKeyboard, type Bot, type CallbackQueryContext } from "grammy";
import { TIMEZONE_SUGGESTIONS, resolveTimezoneInput } from "../../core/timezone-lookup.js";
import { SettingsService, type OnboardingStep } from "../../settings/settings.service.js";
import { bareConfirmationDecision } from "../../core/conversation-control.js";
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
  constructor(
    private readonly settings: SettingsService,
    private readonly screens: ScreensService,
  ) {}

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
    if (onboarding) await this.ask(ctx, "digests");
    else await ctx.reply(t(locale, "timezone_set", { timezone: zone }));
    return true;
  }

  /**
   * A prompt and the pending input that belongs to it. Without the pending input a user who
   * typed «да» instead of tapping sent the answer to the model, and the flow stalled on a
   * question that was already answered.
   */
  private async ask(ctx: AppContext, step: OnboardingStep): Promise<void> {
    const { access, locale } = activeState(ctx);
    const copy = deterministicCopy(locale);
    const prompt =
      step === "digests"
        ? { text: copy.digestsPrompt, keyboard: new InlineKeyboard().text(copy.yes, "onb:digests:on").text(copy.no, "onb:digests:off") }
        : step === "quiet"
          ? { text: copy.quietPrompt, keyboard: new InlineKeyboard().text(copy.defaultLabel, "onb:quiet:default").text(copy.off, "onb:quiet:off") }
          : { text: copy.weeklyPrompt, keyboard: new InlineKeyboard().text(copy.yes, "onb:weekly:on").text(copy.no, "onb:weekly:off") };
    await this.settings.setPendingInput(access.user.id, { kind: "onboarding", step });
    await ctx.reply(prompt.text, { reply_markup: prompt.keyboard });
  }

  /** A typed answer to one of the yes/no steps; anything else re-asks instead of reaching the model. */
  async applyTypedStep(ctx: AppContext, step: OnboardingStep, text: string): Promise<void> {
    const decision = bareConfirmationDecision(text);
    if (!decision) {
      await ctx.reply(t(activeState(ctx).locale, "onb_step_unclear"));
      await this.ask(ctx, step);
      return;
    }
    await this.advance(ctx, step, decision === "confirm");
  }

  /** What each answer does, shared by the button and the typed word. */
  private async advance(ctx: AppContext, step: OnboardingStep, on: boolean): Promise<void> {
    const { access } = activeState(ctx);
    if (step === "digests") {
      await this.settings.setDigestPreset(access.user.id, on);
      return this.ask(ctx, "quiet");
    }
    if (step === "quiet") {
      await this.settings.setQuietHours(
        access.user.id,
        on ? { enabled: true, weekdayStart: "22:00", weekdayEnd: "08:00", weekendStart: "23:00", weekendEnd: "09:00" } : { enabled: false },
      );
      return this.ask(ctx, "weekly");
    }
    await this.settings.setWeeklyPreset(access.user.id, on);
    await this.settings.setPendingInput(access.user.id, null);
    await this.settings.completeOnboarding(access.user.id);
    await ctx.reply(deterministicCopy(activeState(ctx).locale).onboardingDone);
    // The three answers are visible and editable in one place, instead of a bare "done".
    const settings = await this.settings.get(access.user.id);
    if (settings) ctx.state = { ...ctx.state, settings };
    await this.screens.settings_(ctx);
  }

  private async step(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const match = ONBOARD_CALLBACK.exec(ctx.callbackQuery.data);
    const step = match?.[1];
    const value = match?.[2];
    if (!step || !value) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
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
      if (!zone) return void (await ctx.answerCallbackQuery({ text: t(locale, "timezone_invalid") }));
      await this.settings.setTimezone(access.user.id, zone, { applyTo: "both" });
      await ctx.answerCallbackQuery({ text: t(locale, "onb_timezone_saved_toast") });
      await stripButtons();
      await this.ask(ctx, "digests");
      return;
    }
    if (step !== "digests" && step !== "quiet" && step !== "weekly") return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    await ctx.answerCallbackQuery({ text: step === "weekly" ? copy.done : copy.saved });
    await stripButtons();
    await this.advance(ctx, step, value !== "off");
  }
}
