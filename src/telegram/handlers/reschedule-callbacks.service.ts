import { Injectable } from "@nestjs/common";
import { InlineKeyboard, type Bot, type CallbackQueryContext } from "grammy";
import { whenFromRescheduleFields } from "../../actions/action-conversion.js";
import { ActionsService } from "../../actions/actions.service.js";
import type { ResolvedAction } from "../../core/ai-contract.js";
import type { RescheduleFields } from "../../core/reschedule.js";
import { quickRescheduleSchedule, type QuickRescheduleChoice } from "../../core/telegram-ux.js";
import { logger } from "../../observability/logger.js";
import { safeError } from "../../observability/safe-error.js";
import { ReminderSchedulingService } from "../../reminders/reminder-scheduling.service.js";
import { SettingsService } from "../../settings/settings.service.js";
import { TasksService } from "../../tasks/tasks.service.js";
import { t } from "../copy/index.js";
import { activeState, type ActiveAccess, type AppContext } from "../telegram-context.js";
import { quickRescheduleReasonKeyboard, quickRescheduleReasonText, startedTaskKeyboard, taskKeyboard, type QuickRescheduleReasonCode } from "../telegram-ui.js";
import { ScreensService } from "./screens.service.js";

const UUID = "[0-9a-f-]{36}";
const QUICK_RESCHEDULE_CALLBACK = new RegExp(`^resched:(1h|evening|tomorrow|custom):(${UUID})$`);
const QUICK_RESCHEDULE_REASON_CALLBACK = new RegExp(`^rr:(h|e|t):(t|d|e|o):(${UUID})$`);
const FOLLOW_UP_CALLBACK = new RegExp(`^follow:(seen|result):(15m|1h|evening|custom|none):(${UUID})$`);

/**
 * Moving a task in time, and repeating a reminder without moving the task. Both are journaled
 * explicit actions with Undo; «через 15 минут» on a reminder card deliberately changes only the
 * reminder, which is the distinction users lost most often before.
 */
@Injectable()
export class RescheduleCallbacksService {
  constructor(
    private readonly tasks: TasksService,
    private readonly reminders: ReminderSchedulingService,
    private readonly settings: SettingsService,
    private readonly actions: ActionsService,
    private readonly screens: ScreensService,
  ) {}

  register(bot: Bot<AppContext>): void {
    bot.callbackQuery(QUICK_RESCHEDULE_CALLBACK, (ctx) => this.quickReschedule(ctx));
    bot.callbackQuery(QUICK_RESCHEDULE_REASON_CALLBACK, (ctx) => this.quickRescheduleReason(ctx));
    bot.callbackQuery(FOLLOW_UP_CALLBACK, (ctx) => this.followUp(ctx));
  }

  async applyReschedule(access: ActiveAccess, occurrenceId: string, schedule: RescheduleFields, reason?: string) {
    const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
    if (!context) throw new Error("occurrence not found");
    const settings = await this.settings.get(access.user.id);
    const action: ResolvedAction = {
      type: "reschedule",
      intent: "explicit",
      timezone: context.occurrence.timezone,
      reviewTime: settings?.morningReferenceTime ?? "09:00",
      target: {
        kind: "occurrence",
        taskId: context.task.id,
        taskVersion: context.task.version,
        occurrenceId,
        occurrenceVersion: context.occurrence.version,
        timezone: context.occurrence.timezone,
      },
      when: whenFromRescheduleFields(schedule, context.occurrence.timezone),
      recurrence: null,
      reason: reason ?? null,
    };
    return this.actions.applyResolved([action], { workspaceId: access.workspaceId, actorUserId: access.user.id, recipientUserId: access.user.id });
  }

  async buildQuickReschedule(access: ActiveAccess, occurrenceId: string, choice: QuickRescheduleChoice): Promise<RescheduleFields> {
    const [context, settings] = await Promise.all([this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId), this.settings.get(access.user.id)]);
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

  private async completeQuickReschedule(ctx: CallbackQueryContext<AppContext>, occurrenceId: string, choice: QuickRescheduleChoice, reason?: string): Promise<void> {
    const { access, locale } = activeState(ctx);
    const schedule = await this.buildQuickReschedule(access, occurrenceId, choice);
    const applied = await this.applyReschedule(access, occurrenceId, schedule, reason);
    const current = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
    await ctx.answerCallbackQuery({ text: t(locale, "rescheduled_toast") }).catch(() => undefined);
    if (current)
      await ctx
        .editMessageText(await this.screens.taskCard(access.workspaceId, current, locale), {
          reply_markup: this.screens.occurrenceKeyboard(ctx, current, applied.groupId, "undo_reschedule_button"),
        })
        .catch(() => undefined);
  }

  private async quickReschedule(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const match = QUICK_RESCHEDULE_CALLBACK.exec(ctx.callbackQuery.data);
    const choice = match?.[1] as QuickRescheduleChoice | "custom" | undefined;
    const occurrenceId = match?.[2];
    if (!choice || !occurrenceId) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
    if (!context) return this.stale(ctx, "task_not_found_toast");
    if (choice === "custom") {
      await this.settings.setPendingInput(access.user.id, { kind: "reschedule", occurrenceId });
      await ctx.answerCallbackQuery({ text: t(locale, "resched_custom_toast") });
      const hint = t(locale, context.task.timeMode === "window" ? "resched_hint_window" : context.task.timeMode === "deadline" ? "resched_hint_deadline" : "resched_hint_point");
      await ctx
        .editMessageText(`🕒 ${context.task.title}\n\n${t(locale, "resched_prompt", { hint })}`, {
          reply_markup: new InlineKeyboard().text(t(locale, "not_now_button"), `occ:back:${occurrenceId}`),
        })
        .catch(() => undefined);
      return;
    }
    try {
      if (await this.tasks.isRescheduleReasonRequired(access.workspaceId, occurrenceId)) {
        await ctx.answerCallbackQuery({ text: t(locale, "reason_toast") });
        await ctx.editMessageReplyMarkup({ reply_markup: quickRescheduleReasonKeyboard(occurrenceId, choice, locale) }).catch(() => undefined);
        return;
      }
      await this.completeQuickReschedule(ctx, occurrenceId, choice);
    } catch (error) {
      logger.error("quick reschedule failed", { occurrenceId, choice, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: t(locale, "resched_failed_toast") }).catch(() => undefined);
    }
  }

  private async quickRescheduleReason(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const match = QUICK_RESCHEDULE_REASON_CALLBACK.exec(ctx.callbackQuery.data);
    const choice = quickChoiceFromCode(match?.[1]);
    const code = quickReasonFromCode(match?.[2]);
    const occurrenceId = match?.[3];
    if (!choice || !code || !occurrenceId) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    if (code === "other") {
      await this.settings.setPendingInput(access.user.id, { kind: "quick_reschedule_reason", occurrenceId, choice });
      const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
      await ctx.answerCallbackQuery({ text: t(locale, "reason_write_toast") });
      if (context) {
        await ctx
          .editMessageText(t(locale, "reason_prompt_text", { title: context.task.title }), {
            reply_markup: new InlineKeyboard().text(t(locale, "back_button"), `occ:resched:${occurrenceId}`).text(t(locale, "not_now_button"), `occ:back:${occurrenceId}`),
          })
          .catch(() => undefined);
      }
      return;
    }
    try {
      const reason = quickRescheduleReasonText(code, locale);
      if (!reason) throw new Error("reason missing");
      await this.completeQuickReschedule(ctx, occurrenceId, choice, reason);
    } catch (error) {
      logger.error("quick reschedule reason failed", { occurrenceId, choice, code, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: t(locale, "resched_failed_toast") }).catch(() => undefined);
    }
  }

  /** `follow:seen:*` on a reminder card repeats the reminder later without touching the task's time. */
  private async followUp(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const match = FOLLOW_UP_CALLBACK.exec(ctx.callbackQuery.data);
    const mode = match?.[1] as "seen" | "result" | undefined;
    const choice = match?.[2] as "15m" | "1h" | "evening" | "custom" | "none" | undefined;
    const occurrenceId = match?.[3];
    if (!mode || !choice || !occurrenceId) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    try {
      if (choice === "none") {
        if (mode !== "result") return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
        await ctx.answerCallbackQuery({ text: t(locale, "followup_none_toast") });
        await ctx.editMessageReplyMarkup({ reply_markup: startedTaskKeyboard(occurrenceId, locale) }).catch(() => undefined);
        return;
      }
      if (choice === "custom") {
        await this.settings.setPendingInput(access.user.id, { kind: "follow_up_custom", occurrenceId, mode });
        await ctx.answerCallbackQuery({ text: t(locale, "followup_custom_toast") });
        await ctx.reply(t(locale, "followup_custom_prompt"), { reply_markup: new InlineKeyboard().text(t(locale, "not_now_button"), `occ:back:${occurrenceId}`) });
        return;
      }
      const scheduled = await this.reminders.scheduleFollowUpChoice({ workspaceId: access.workspaceId, userId: access.user.id, occurrenceId, choice, mode });
      if (!scheduled) return this.stale(ctx, "task_unavailable_toast");
      await ctx.answerCallbackQuery({ text: t(locale, mode === "seen" ? "snooze_reminder_toast" : "followup_updated_toast") });
      const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
      const keyboard = context
        ? context.occurrence.status === "in_progress"
          ? startedTaskKeyboard(occurrenceId, locale)
          : taskKeyboard(occurrenceId, context.occurrence.status, locale)
        : new InlineKeyboard();
      await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => undefined);
    } catch (error) {
      logger.error("follow-up callback failed", { occurrenceId, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: t(locale, "followup_failed_toast") }).catch(() => undefined);
    }
  }

  /** A stale button answers with a toast and loses its keyboard, so the card stops inviting the same failing tap. */
  private async stale(
    ctx: CallbackQueryContext<AppContext>,
    key: "task_not_found_toast" | "task_unavailable_toast" | "state_changed_toast" | "series_not_found_toast" | "series_changed_toast" | "action_stale_toast",
  ): Promise<void> {
    await ctx.answerCallbackQuery({ text: t(ctx.state.locale, key) }).catch(() => undefined);
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
  }
}

function quickChoiceFromCode(value?: string): QuickRescheduleChoice | undefined {
  return value === "h" ? "1h" : value === "e" ? "evening" : value === "t" ? "tomorrow" : undefined;
}

function quickReasonFromCode(value?: string): QuickRescheduleReasonCode | undefined {
  return value === "t" ? "time" : value === "d" ? "dependency" : value === "e" ? "energy" : value === "o" ? "other" : undefined;
}
