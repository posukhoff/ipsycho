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
import { quickRescheduleKeyboard, terminalTaskText } from "../telegram-ui.js";
import { TaskCardService, type OccurrenceContext } from "./task-card.service.js";
import { logger } from "../../observability/logger.js";

const UUID = "[0-9a-f-]{36}";
const OCCURRENCE_CALLBACK = new RegExp(`^occ:(done|skip|resched|back):(${UUID})$`);
const MUTE_CALLBACK = new RegExp(`^rem:mute:(${UUID})$`);
const ACTION_CALLBACK = new RegExp(`^act:(confirm|cancel|undo):(${UUID})$`);

/** Buttons on task, reminder and confirmation cards. Every state change goes through the action journal so it can be undone. */
@Injectable()
export class TaskCallbacksService {
  constructor(
    private readonly tasks: TasksService,
    private readonly reminders: ReminderSchedulingService,
    private readonly settings: SettingsService,
    private readonly actions: ActionsService,
    private readonly card: TaskCardService,
  ) {}

  register(bot: Bot<AppContext>): void {
    bot.callbackQuery(OCCURRENCE_CALLBACK, (ctx) => this.occurrence(ctx));
    bot.callbackQuery(MUTE_CALLBACK, (ctx) => this.muteReminders(ctx));
    bot.callbackQuery(ACTION_CALLBACK, (ctx) => this.action(ctx));
  }

  private async occurrence(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale, webAppUrl } = activeState(ctx);
    const match = OCCURRENCE_CALLBACK.exec(ctx.callbackQuery.data);
    const action = match?.[1];
    const occurrenceId = match?.[2];
    if (!action || !occurrenceId) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    try {
      const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
      if (!context) return this.stale(ctx, "task_not_found_toast");

      if (action === "back") {
        // "Back" also leaves a pending free-text prompt (a blocker, a new time) so the next message goes to the model again.
        await this.settings.setPendingInput(access.user.id, null);
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: this.card.keyboard(ctx, context) }).catch(() => undefined);
        return;
      }
      if (action === "resched") {
        await ctx.answerCallbackQuery({ text: t(locale, "resched_prompt_toast") });
        await ctx.editMessageReplyMarkup({ reply_markup: quickRescheduleKeyboard(occurrenceId, locale, webAppUrl) }).catch(() => undefined);
        return;
      }
      const state = action === "done" ? "done" : "skipped";
      const applied = await this.applyState(access, context, state);
      await ctx.answerCallbackQuery({ text: t(locale, action === "done" ? "done_occurrence_toast" : "skipped_toast") });
      // A one-tap terminal change keeps its way back on the card itself.
      await ctx
        .editMessageText(terminalTaskText(context.task, state, new Date(), locale), {
          reply_markup: new InlineKeyboard().text(t(locale, "undo_button"), `act:undo:${applied.groupId}`),
        })
        .catch(() => ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined));
    } catch (error) {
      logger.error("occurrence callback failed", { action, occurrenceId, error: safeError(error) });
      await this.stale(ctx, "state_changed_toast");
    }
  }

  /** The button is an explicit instruction; it is journaled like the same change typed in chat, with Undo. */
  private async applyState(access: ActiveAccess, context: OccurrenceContext, state: "done" | "skipped") {
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

  /** On an escalation card the id is the occurrence: stop every default reminder for it. */
  private async muteReminders(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, locale } = activeState(ctx);
    const occurrenceId = MUTE_CALLBACK.exec(ctx.callbackQuery.data)?.[1];
    if (!occurrenceId) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    await this.reminders
      .muteDefaultReminders({ workspaceId: access.workspaceId, userId: access.user.id, occurrenceId })
      .catch((error) => logger.error("mute escalation failed", { occurrenceId, error: safeError(error) }));
    await ctx.answerCallbackQuery({ text: t(locale, "mute_escalation_toast") }).catch(() => undefined);
    const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
    await ctx.editMessageReplyMarkup({ reply_markup: context ? this.card.keyboard(ctx, context) : new InlineKeyboard() }).catch(() => undefined);
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
  private async stale(ctx: CallbackQueryContext<AppContext>, key: "task_not_found_toast" | "state_changed_toast" | "action_stale_toast"): Promise<void> {
    await ctx.answerCallbackQuery({ text: t(ctx.state.locale, key) }).catch(() => undefined);
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
  }
}
