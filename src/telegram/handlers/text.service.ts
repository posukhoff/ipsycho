import { Injectable } from "@nestjs/common";
import { InlineKeyboard, type Bot, type Filter } from "grammy";
import { ActionStateUncertainError } from "../../actions/actions.service.js";
import { ChatService } from "../../chat/chat.service.js";
import { renderAppliedReport } from "../../core/applied-report.js";
import { detectConversationControl } from "../../core/conversation-control.js";
import { parseCustomFollowUpInput, parseRescheduleInput } from "../../core/deterministic-input.js";
import { formatLocalDateTime } from "../../core/time-presentation.js";
import { safeError, safeMessageMetadata } from "../../observability/safe-error.js";
import { ReminderSchedulingService } from "../../reminders/reminder-scheduling.service.js";
import { SettingsService, type PendingInput } from "../../settings/settings.service.js";
import { TasksService } from "../../tasks/tasks.service.js";
import { t } from "../copy/index.js";
import { TelegramChatReplyService } from "../telegram-chat-reply.service.js";
import { activeState, type AppContext } from "../telegram-context.js";
import { OnboardingService } from "./onboarding.service.js";
import { ScreensService } from "./screens.service.js";
import { TaskCallbacksService } from "./task-callbacks.service.js";

type TextContext = Filter<AppContext, "message:text">;

/** Telegram clears the typing status after a few seconds or on the next message; refresh it while the model works. */
const TYPING_REFRESH_MS = 4_000;

/** Free text: the one place that talks to the model, plus the short-lived prompts a button opened. */
@Injectable()
export class TextService {
  constructor(
    private readonly settings: SettingsService,
    private readonly tasks: TasksService,
    private readonly reminders: ReminderSchedulingService,
    private readonly chat: ChatService,
    private readonly chatReply: TelegramChatReplyService,
    private readonly screens: ScreensService,
    private readonly taskCallbacks: TaskCallbacksService,
    private readonly onboarding: OnboardingService,
  ) {}

  register(bot: Bot<AppContext>): void {
    bot.on("message:text", (ctx) => this.text(ctx));
  }

  /** Registered last: anything without a handler above gets a sentence instead of silence. */
  registerFallback(bot: Bot<AppContext>): void {
    bot.on("message", async (ctx) => {
      await ctx.reply(t(ctx.state.locale, "unsupported_message"));
    });
  }

  private async text(ctx: TextContext): Promise<void> {
    if (ctx.message.text.startsWith("/")) return;
    const { access, settings, locale } = activeState(ctx);

    if (isUntilMorningPhrase(ctx.message.text)) {
      const until = await this.settings.snoozeUntilMorning(access.user.id);
      await ctx.reply(t(locale, "until_morning", { until: formatLocalDateTime(until, settings.timezone, new Date()) }));
      return;
    }

    const pending = await this.settings.consumePendingInput(access.user.id);
    if (pending) return this.pendingInput(ctx, pending);

    const control = detectConversationControl(ctx.message.text);
    if (control === "end") {
      const ended = await this.chat.endConversation(access.workspaceId, access.user.id);
      await ctx.reply(t(locale, ended ? "end_done" : "end_none"));
      return;
    }
    if (control === "conclude") {
      const result = await this.withTyping(ctx, () => this.chat.concludeConversation({
        workspaceId: access.workspaceId, userId: access.user.id, aiStatus: access.user.aiStatus, timezone: settings.timezone, language: settings.pinnedLanguage,
      }));
      await this.chatReply.reply(ctx, access, result);
      return;
    }

    await this.processWithModel(ctx);
  }

  private async processWithModel(ctx: TextContext, focus?: { occurrenceId: string; action: "reschedule" | "blocker" }): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    try {
      const result = await this.withTyping(ctx, () => this.chat.processText({
        workspaceId: access.workspaceId,
        userId: access.user.id,
        aiStatus: access.user.aiStatus,
        timezone: settings.timezone,
        language: settings.pinnedLanguage ?? ctx.from.language_code ?? null,
        text: ctx.message.text,
        telegramChatId: ctx.chat.id,
        telegramMessageId: ctx.message.message_id,
        ...(focus ? { focus } : {}),
      }));
      await this.chatReply.reply(ctx, access, result);
    } catch (error) {
      console.error("text processing failed", { userId: access.user.id, messageId: ctx.message.message_id, message: safeMessageMetadata(ctx.message.text), error: safeError(error) });
      await ctx.reply(t(locale, error instanceof ActionStateUncertainError ? "text_uncertain" : "text_failed")).catch(() => undefined);
    }
  }

  /** The model takes seconds; without this the user sees nothing at all until the reply lands. */
  private async withTyping<T>(ctx: TextContext, work: () => Promise<T>): Promise<T> {
    const typing = () => ctx.replyWithChatAction("typing").catch(() => undefined);
    await typing();
    const timer = setInterval(() => void typing(), TYPING_REFRESH_MS);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  private async pendingInput(ctx: TextContext, pending: PendingInput): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const timezone = settings.timezone;
    try {
      if (pending.kind === "timezone") {
        await this.onboarding.applyTypedTimezone(ctx, ctx.message.text, pending.onboarding);
        return;
      }
      if (pending.kind === "quick_reschedule_reason") {
        const reason = ctx.message.text.trim();
        if (reason.length < 2) throw new Error("reschedule reason is too short");
        const schedule = await this.taskCallbacks.buildQuickReschedule(access, pending.occurrenceId, pending.choice);
        const applied = await this.taskCallbacks.applyReschedule(access, pending.occurrenceId, schedule, reason);
        const current = await this.tasks.getOccurrenceContext(access.workspaceId, pending.occurrenceId);
        if (current) await ctx.reply(await this.screens.taskCard(access.workspaceId, current, locale), { reply_markup: this.screens.occurrenceKeyboard(ctx, current, applied.groupId, "undo_reschedule_button") });
        else await ctx.reply(t(locale, "rescheduled_text"));
        return;
      }
      if (pending.kind === "blocker") {
        await this.tasks.recordBlocker({ workspaceId: access.workspaceId, occurrenceId: pending.occurrenceId, actorUserId: access.user.id, details: ctx.message.text });
        await this.processWithModel(ctx, { occurrenceId: pending.occurrenceId, action: "blocker" });
        return;
      }
      if (pending.kind === "follow_up_custom") {
        const intendedFor = parseCustomFollowUpInput(ctx.message.text, timezone, new Date());
        await this.reminders.scheduleCustomFollowUp({ workspaceId: access.workspaceId, userId: access.user.id, occurrenceId: pending.occurrenceId, intendedFor, mode: pending.mode });
        await ctx.reply(t(locale, "followup_done", { when: formatLocalDateTime(intendedFor, timezone, new Date()) }));
        return;
      }

      const context = await this.tasks.getOccurrenceContext(access.workspaceId, pending.occurrenceId);
      if (!context) throw new Error("occurrence not found");
      let parsed: ReturnType<typeof parseRescheduleInput> | null = null;
      try {
        parsed = parseRescheduleInput(ctx.message.text, context.task.timeMode, timezone);
      } catch {
        parsed = null;
      }
      if (!parsed) {
        // Free text after the Reschedule button is the new time in the user's own words:
        // the model reads it with the task in focus instead of a strict format loop.
        await this.processWithModel(ctx, { occurrenceId: pending.occurrenceId, action: "reschedule" });
        return;
      }
      const applied = await this.taskCallbacks.applyReschedule(access, pending.occurrenceId, parsed.schedule, parsed.reason);
      const report = applied.items?.length ? renderAppliedReport(applied.items, new Date(), locale) : "";
      const headline = t(locale, parsed.schedule.fuzzyHorizonText ? "rescheduled_fuzzy_text" : "rescheduled_text");
      await ctx.reply(report ? `${headline}\n\n${report}` : headline, { reply_markup: new InlineKeyboard().text(t(locale, "undo_reschedule_button"), `act:undo:${applied.groupId}`) });
      if (!parsed.schedule.fuzzyHorizonText) {
        const count = await this.tasks.countOccurrenceEvents(access.workspaceId, pending.occurrenceId, "occurrence:rescheduled");
        if (count >= 2) {
          await ctx.reply(t(locale, "repeated_reschedule"), {
            reply_markup: new InlineKeyboard().text(t(locale, "cant_start_button"), `occ:cant:${pending.occurrenceId}`).text(t(locale, "started_button"), `occ:start:${pending.occurrenceId}`),
          });
        }
      }
    } catch (error) {
      console.warn("pending input handling failed", { userId: access.user.id, kind: pending.kind, error: safeError(error) });
      if (pending.kind === "blocker") return void await ctx.reply(t(locale, "blocker_failed"));
      if (pending.kind === "reschedule") return void await ctx.reply(t(locale, "resched_failed_text"));
      if (pending.kind === "timezone") return;
      await this.settings.setPendingInput(access.user.id, pending);
      if (pending.kind === "quick_reschedule_reason") return void await ctx.reply(t(locale, "reason_too_short"));
      await ctx.reply(t(locale, "followup_parse_failed"), { reply_markup: new InlineKeyboard().text(t(locale, "not_now_button"), `occ:back:${pending.occurrenceId}`) });
    }
  }
}

function isUntilMorningPhrase(text: string): boolean {
  return /(?:замолчи|мовчи|не пиши(?: мне)?|quiet|don'?t (?:message|write))\s+(?:до|until|till)\s+(?:утра|ранку|morning)|(?:до|until|till)\s+(?:утра|ранку|morning).*(?:замолчи|мовчи|не пиши|quiet)/iu.test(text.trim());
}
