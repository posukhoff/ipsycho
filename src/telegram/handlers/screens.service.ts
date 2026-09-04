import { Injectable } from "@nestjs/common";
import { InlineKeyboard } from "grammy";
import { ChatService } from "../../chat/chat.service.js";
import { ContextService } from "../../context/context.service.js";
import { formatLocalDateTime } from "../../core/time-presentation.js";
import { localDateAt } from "../../core/timezone.js";
import { ReminderSchedulingService } from "../../reminders/reminder-scheduling.service.js";
import { TasksService } from "../../tasks/tasks.service.js";
import { t } from "../copy/index.js";
import { activeState, type AppContext } from "../telegram-context.js";
import type { TelegramLocale } from "../telegram-locale.js";
import {
  fuzzyTaskCardText, fuzzyTaskDetailKeyboard, goalsOverviewText, remindersKeyboard, screenFooterKeyboard, settingsKeyboard, settingsText,
  startedTaskKeyboard, taskCardText, taskDetailKeyboard, taskKeyboard, taskListKeyboard, tasksOverviewText, todayText,
} from "../telegram-ui.js";

export type OccurrenceContext = NonNullable<Awaited<ReturnType<TasksService["getOccurrenceContext"]>>>;

/** Renders the main screens; a callback edits the message it came from, a command sends a new one. */
@Injectable()
export class ScreensService {
  constructor(
    private readonly tasks: TasksService,
    private readonly reminders: ReminderSchedulingService,
    private readonly context: ContextService,
    private readonly chat: ChatService,
  ) {}

  async present(ctx: AppContext, text: string, keyboard?: InlineKeyboard, edit = false): Promise<void> {
    const options = { reply_markup: keyboard ?? new InlineKeyboard() };
    if (edit && ctx.callbackQuery?.message) {
      const edited = await ctx.editMessageText(text, options).then(() => true).catch(() => false);
      if (edited) return;
    }
    await ctx.reply(text, keyboard ? { reply_markup: keyboard } : {});
  }

  async tasks_(ctx: AppContext, edit = false): Promise<void> {
    const { access, locale } = activeState(ctx);
    const items = await this.tasks.listForTelegram(access.workspaceId, 50);
    await this.present(ctx, tasksOverviewText(items, locale), taskListKeyboard(items, locale, { visibleCount: 8 }), edit);
  }

  async reminders_(ctx: AppContext, edit = false): Promise<void> {
    const { access, locale } = activeState(ctx);
    const rows = await this.reminders.listUpcoming({ workspaceId: access.workspaceId, userId: access.user.id, limit: 8 });
    if (!rows.length) return this.present(ctx, t(locale, "reminders_none"), screenFooterKeyboard(locale), edit);
    const now = new Date();
    const lines = [t(locale, "reminders_title"), ""];
    const buttons = rows.map(({ delivery, task }, index) => {
      const when = formatLocalDateTime(delivery.scheduledFor, task.timezone, now);
      lines.push(`${index + 1}. ${task.title} · ${when}`);
      return { deliveryId: delivery.id, title: `${index + 1}. ${task.title}`, when };
    });
    lines.push("", t(locale, "reminders_hint"));
    await this.present(ctx, lines.join("\n"), remindersKeyboard(buttons, locale), edit);
  }

  async today(ctx: AppContext, edit = false, showAll = false): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const now = new Date();
    const localDate = localDateAt(now, settings.timezone);
    const [items, completed] = await Promise.all([
      this.tasks.listTodayForTelegram(access.workspaceId, localDate, 20),
      this.tasks.listCompletedTodayForTelegram(access.workspaceId, localDate),
    ]);
    const visible = showAll ? 20 : 6;
    await this.present(ctx, todayText(items, localDate, locale, completed.length, visible), taskListKeyboard(items, locale, { showAll: !showAll, allCount: items.length, visibleCount: visible, expanded: showAll }), edit);
  }

  async goals(ctx: AppContext, edit = false): Promise<void> {
    const { access, locale } = activeState(ctx);
    const items = await this.context.goalsOverview(access.workspaceId);
    await this.present(ctx, goalsOverviewText(items, locale), screenFooterKeyboard(locale), edit);
  }

  async settings_(ctx: AppContext, edit = false): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const historyMessageCount = await this.chat.historyMessageCount(access.workspaceId, access.user.id);
    await this.present(ctx, settingsText(settings, new Date(), historyMessageCount, locale), settingsKeyboard(locale, settings), edit);
  }

  /** Full task card: row fields plus checklist, goal and the next reminder that will actually fire. */
  async taskCard(workspaceId: string, context: OccurrenceContext, locale: TelegramLocale = "ru"): Promise<string> {
    const [extras, nextReminderAt] = await Promise.all([
      this.tasks.getTaskCardExtras(workspaceId, context.task.id).catch(() => ({ checklist: [], goalTitle: null })),
      this.reminders.nextUserReminderAt(workspaceId, context.occurrence.id).catch(() => null),
    ]);
    return taskCardText({ ...context.task, ...extras, nextReminderAt }, context.occurrence, new Date(), locale);
  }

  async showOccurrence(ctx: AppContext, occurrenceId: string): Promise<boolean> {
    const { access, locale } = activeState(ctx);
    const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
    if (!context) return false;
    await ctx.editMessageText(await this.taskCard(access.workspaceId, context, locale), { reply_markup: taskDetailKeyboard(occurrenceId, context.occurrence.status, locale) }).catch(() => undefined);
    return true;
  }

  async showFuzzyTask(ctx: AppContext, taskId: string): Promise<boolean> {
    const { access, locale } = activeState(ctx);
    const task = await this.tasks.getTask(access.workspaceId, taskId);
    if (!task || task.status !== "active" || task.timeMode !== "fuzzy") return false;
    const extras = await this.tasks.getTaskCardExtras(access.workspaceId, task.id).catch(() => ({ checklist: [], goalTitle: null }));
    await ctx.editMessageText(fuzzyTaskCardText({ ...task, ...extras }, new Date(), locale), { reply_markup: fuzzyTaskDetailKeyboard(locale) }).catch(() => undefined);
    return true;
  }

  /** The card's own keyboard for its current state, optionally with an Undo row for what just happened. */
  occurrenceKeyboard(ctx: AppContext, context: OccurrenceContext, undoGroupId?: string, undoLabel: "undo_button" | "undo_reschedule_button" = "undo_button"): InlineKeyboard {
    const { locale } = activeState(ctx);
    const keyboard = context.occurrence.status === "in_progress" ? startedTaskKeyboard(context.occurrence.id, locale) : taskKeyboard(context.occurrence.id, context.occurrence.status, locale);
    if (undoGroupId) keyboard.row().text(t(locale, undoLabel), `act:undo:${undoGroupId}`);
    return keyboard;
  }
}
