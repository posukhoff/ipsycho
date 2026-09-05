import { Injectable } from "@nestjs/common";
import { InlineKeyboard, type Bot, type CallbackQueryContext } from "grammy";
import { ActionStateUncertainError, ActionsService } from "../../actions/actions.service.js";
import type { ResolvedAction } from "../../core/ai-contract.js";
import { renderAppliedReport } from "../../core/applied-report.js";
import { safeError } from "../../observability/safe-error.js";
import { ReminderSchedulingService } from "../../reminders/reminder-scheduling.service.js";
import { SettingsService } from "../../settings/settings.service.js";
import { TasksService } from "../../tasks/tasks.service.js";
import { t } from "../copy/index.js";
import { activeState, type ActiveAccess, type AppContext } from "../telegram-context.js";
import { quickRescheduleKeyboard, taskMoreKeyboard, terminalTaskText } from "../telegram-ui.js";
import { ScreensService, type OccurrenceContext } from "./screens.service.js";
import { logger } from "../../observability/logger.js";

const UUID = "[0-9a-f-]{36}";
const VIEW_CALLBACK = new RegExp(`^view:(occ|task):(${UUID})$`);
const OCCURRENCE_CALLBACK = new RegExp(`^occ:(done|skip|cancel|cancel_one|resched|more|back):(${UUID})$`);
const SERIES_CALLBACK = new RegExp(`^series:(pause|resume|cancel):(${UUID})$`);
const REMINDER_CALLBACK = new RegExp(`^rem:(cancel|mute):(${UUID})$`);
const ACTION_CALLBACK = new RegExp(`^act:(confirm|cancel|undo):(${UUID})$`);

/** Buttons on task, reminder and confirmation cards. Every state change goes through the action journal so it can be undone. */
@Injectable()
export class TaskCallbacksService {
  constructor(
    private readonly tasks: TasksService,
    private readonly reminders: ReminderSchedulingService,
    private readonly settings: SettingsService,
    private readonly actions: ActionsService,
    private readonly screens: ScreensService,
  ) {}

  register(bot: Bot<AppContext>): void {
    bot.callbackQuery(VIEW_CALLBACK, (ctx) => this.view(ctx));
    bot.callbackQuery(OCCURRENCE_CALLBACK, (ctx) => this.occurrence(ctx));
    bot.callbackQuery(SERIES_CALLBACK, (ctx) => this.series(ctx));
    bot.callbackQuery(REMINDER_CALLBACK, (ctx) => this.cancelReminder(ctx));
    bot.callbackQuery(ACTION_CALLBACK, (ctx) => this.action(ctx));
  }

  private async view(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const match = VIEW_CALLBACK.exec(ctx.callbackQuery.data);
    const kind = match?.[1];
    const id = match?.[2];
    if (!kind || !id) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    const shown = kind === "occ" ? await this.screens.showOccurrence(ctx, id) : await this.screens.showFuzzyTask(ctx, id);
    if (!shown) return this.stale(ctx, "task_unavailable_toast");
    await ctx.answerCallbackQuery();
  }

  private async occurrence(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const match = OCCURRENCE_CALLBACK.exec(ctx.callbackQuery.data);
    const action = match?.[1];
    const occurrenceId = match?.[2];
    if (!action || !occurrenceId) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    try {
      const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
      if (!context) return this.stale(ctx, "task_not_found_toast");
      const recurring = Boolean(context.task.recurrenceRule);

      if (action === "more") {
        await ctx.answerCallbackQuery();
        await ctx
          .editMessageReplyMarkup({ reply_markup: taskMoreKeyboard(occurrenceId, recurring, context.task.id, locale, !context.task.recurrenceEndLocalDate) })
          .catch(() => undefined);
        return;
      }
      if (action === "back") {
        // "Back" also leaves a pending free-text prompt (a blocker, a new time) so the next message goes to the model again.
        await this.settings.setPendingInput(access.user.id, null);
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: this.screens.occurrenceKeyboard(ctx, context) }).catch(() => undefined);
        return;
      }
      if (action === "resched") {
        await ctx.answerCallbackQuery({ text: t(locale, "resched_prompt_toast") });
        await ctx.editMessageReplyMarkup({ reply_markup: quickRescheduleKeyboard(occurrenceId, locale) }).catch(() => undefined);
        return;
      }
      const state = action === "done" ? "done" : action === "skip" ? "skipped" : "cancelled";
      const applied = await this.applyState(access, context, state);
      await ctx.answerCallbackQuery({
        text: t(locale, action === "done" ? "done_occurrence_toast" : action === "skip" ? "skipped_toast" : "cancelled_occurrence_toast"),
      });
      // A one-tap terminal change keeps its way back on the card itself.
      await ctx
        .editMessageText(terminalTaskText(context.task, state === "done" ? "done" : state === "skipped" ? "skipped" : "cancelled", new Date(), locale), {
          reply_markup: new InlineKeyboard().text(t(locale, "undo_button"), `act:undo:${applied.groupId}`),
        })
        .catch(() => ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined));
    } catch (error) {
      logger.error("occurrence callback failed", { action, occurrenceId, error: safeError(error) });
      await this.stale(ctx, "state_changed_toast");
    }
  }

  /** The button is an explicit instruction; it is journaled like the same change typed in chat, with Undo. */
  private async applyState(access: ActiveAccess, context: OccurrenceContext, state: "done" | "skipped" | "cancelled") {
    const settings = await this.settings.get(access.user.id);
    const action: ResolvedAction = {
      type: "set_task_state",
      intent: "explicit",
      timezone: context.occurrence.timezone,
      reviewTime: settings?.morningReferenceTime ?? "09:00",
      target: {
        kind: "occurrence",
        taskId: context.task.id,
        taskVersion: context.task.version,
        occurrenceId: context.occurrence.id,
        occurrenceVersion: context.occurrence.version,
        timezone: context.occurrence.timezone,
      },
      state,
    };
    return this.actions.applyResolved([action], { workspaceId: access.workspaceId, actorUserId: access.user.id, recipientUserId: access.user.id });
  }

  private async series(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const match = SERIES_CALLBACK.exec(ctx.callbackQuery.data);
    const operation = match?.[1] as "pause" | "resume" | "cancel" | undefined;
    const taskId = match?.[2];
    if (!operation || !taskId) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    const task = await this.tasks.getTask(access.workspaceId, taskId);
    if (!task) return this.stale(ctx, "series_not_found_toast");
    try {
      const result = await this.actions.applySeriesOperation(
        { workspaceId: access.workspaceId, actorUserId: access.user.id, recipientUserId: access.user.id },
        taskId,
        task.version,
        operation,
      );
      const message = t(locale, operation === "pause" ? "series_paused" : operation === "resume" ? "series_resumed" : "series_cancelled");
      await ctx.answerCallbackQuery({ text: message });
      // Resume comes from the paused list, and the row it acted on is gone: redraw that screen
      // instead of leaving a list that still shows the series as paused.
      if (operation === "resume") await this.screens.pausedSeries_(ctx, true);
      else await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
      // Resume materializes dates outside the journal, so undo would restore the paused parent and
      // leave those dates live and reminding. Pausing again is the honest way back, and the card
      // offers it as soon as the series is active.
      if (result.applied && operation !== "resume")
        await ctx.reply(`${message}.`, { reply_markup: new InlineKeyboard().text(t(locale, "undo_button"), `act:undo:${result.applied.groupId}`) });
      else if (result.applied) await ctx.reply(`${message}.`);
    } catch (error) {
      logger.error("series callback failed", { taskId, error: safeError(error) });
      await this.stale(ctx, "series_changed_toast");
    }
  }

  private async cancelReminder(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const match = REMINDER_CALLBACK.exec(ctx.callbackQuery.data);
    const operation = match?.[1];
    const deliveryId = match?.[2];
    if (!operation || !deliveryId) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    if (operation === "mute") {
      // On an escalation card the id is the occurrence: stop every default reminder for it.
      await this.reminders
        .muteDefaultReminders({ workspaceId: access.workspaceId, userId: access.user.id, occurrenceId: deliveryId })
        .catch((error) => logger.error("mute escalation failed", { occurrenceId: deliveryId, error: safeError(error) }));
      await ctx.answerCallbackQuery({ text: t(locale, "mute_escalation_toast") }).catch(() => undefined);
      const context = await this.tasks.getOccurrenceContext(access.workspaceId, deliveryId);
      await ctx.editMessageReplyMarkup({ reply_markup: context ? this.screens.occurrenceKeyboard(ctx, context) : new InlineKeyboard() }).catch(() => undefined);
      return;
    }
    try {
      const cancelled = await this.reminders.cancelUpcoming({ workspaceId: access.workspaceId, userId: access.user.id, deliveryId });
      await ctx.answerCallbackQuery({ text: t(locale, cancelled ? "reminder_cancelled_toast" : "reminder_already_toast") });
      await this.screens.reminders_(ctx, true);
    } catch (error) {
      logger.error("reminder cancellation failed", { deliveryId, error: safeError(error) });
      await ctx.answerCallbackQuery({ text: t(locale, "reminder_cancel_failed_toast") }).catch(() => undefined);
    }
  }

  private async action(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const match = ACTION_CALLBACK.exec(ctx.callbackQuery.data);
    const action = match?.[1];
    const groupId = match?.[2];
    if (!action || !groupId) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    try {
      if (action === "confirm") {
        const result = await this.actions.confirm(access.workspaceId, access.user.id, access.user.id, groupId);
        await ctx.answerCallbackQuery({ text: result.count === 1 ? t(locale, "confirm_toast") : t(locale, "confirm_toast_many", { count: result.count }) }).catch(() => undefined);
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
        // The toast disappears; the persisted outcome deserves a message of its own, with Undo attached.
        const report = result.items?.length ? renderAppliedReport(result.items, new Date(), locale) : "";
        const text = `${t(locale, "confirmed_text")}${report ? `\n\n${report}` : ""}\n\n${t(locale, "action_done_undo_hint")}`;
        await ctx.reply(text, { reply_markup: new InlineKeyboard().text(t(locale, "undo_button"), `act:undo:${groupId}`) }).catch(() => undefined);
        return;
      }
      if (action === "cancel") {
        const cancelled = await this.actions.cancel(access.workspaceId, access.user.id, groupId);
        await ctx.answerCallbackQuery({ text: t(locale, cancelled ? "declined_toast" : "already_handled_toast") }).catch(() => undefined);
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
        return;
      }
      await this.actions.undo(access.workspaceId, access.user.id, groupId);
      await ctx.answerCallbackQuery({ text: t(locale, "undo_toast") }).catch(() => undefined);
      // The message still describes the change; say on it that the change is gone.
      const current = ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : undefined;
      if (current)
        await ctx
          .editMessageText(`${t(locale, "undo_text")}\n\n${current}`, { reply_markup: new InlineKeyboard() })
          .catch(() => ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined));
      else await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    } catch (error) {
      logger.error("action callback failed", { action, groupId, error: safeError(error) });
      if (error instanceof ActionStateUncertainError) return void (await ctx.answerCallbackQuery({ text: t(locale, "action_uncertain_toast") }).catch(() => undefined));
      await this.stale(ctx, "action_stale_toast");
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
