import { Injectable } from "@nestjs/common";
import { InlineKeyboard } from "grammy";
import { ChatService } from "../../chat/chat.service.js";
import { ContextService } from "../../context/context.service.js";
import { formatLocalDateTime } from "../../core/time-presentation.js";
import { DEFAULT_TASK_SCOPE, paginate, type TaskScope } from "../../core/task-list-view.js";
import { localDateAt } from "../../core/timezone.js";
import { isPickLive } from "../../core/week-plan.js";
import { ReminderSchedulingService } from "../../reminders/reminder-scheduling.service.js";
import { TasksService } from "../../tasks/tasks.service.js";
import { t } from "../copy/index.js";
import { activeState, type AppContext } from "../telegram-context.js";
import type { TelegramLocale } from "../telegram-locale.js";
import {
  appendFooter,
  fuzzyTaskCardText,
  fuzzyTaskDetailKeyboard,
  goalDetailKeyboard,
  goalDetailText,
  goalListKeyboard,
  goalsOverviewText,
  goalsScopeKeyboard,
  languageKeyboard,
  pausedSeriesKeyboard,
  pausedSeriesText,
  weekPlanKeyboard,
  weekPlanText,
  remindersKeyboard,
  remindersText,
  screenFooterKeyboard,
  settingsKeyboard,
  settingsText,
  taskCardText,
  taskDetailKeyboard,
  taskGroupKeyboard,
  taskGroupText,
  taskKeyboard,
  taskListKeyboard,
  taskScopeKeyboard,
  tasksOverviewText,
  todayText,
  type GoalScope,
  type GroupSource,
} from "../telegram-ui.js";

export type OccurrenceContext = NonNullable<Awaited<ReturnType<TasksService["getOccurrenceContext"]>>>;

/** How many groups one screen shows before it pages; a Telegram message stays readable at eight lines. */
const PAGE_SIZE = 8;

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
      const edited = await ctx
        .editMessageText(text, options)
        .then(() => true)
        .catch(() => false);
      if (edited) return;
    }
    await ctx.reply(text, keyboard ? { reply_markup: keyboard } : {});
  }

  async tasks_(ctx: AppContext, edit = false, scope: TaskScope = DEFAULT_TASK_SCOPE, page = 0): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const localDate = localDateAt(new Date(), settings.timezone);
    const { groups, counts, pausedCount } = await this.tasks.listGroupedForTelegram(access.workspaceId, { scope, localDate });
    const view = paginate(groups, page, PAGE_SIZE);
    const keyboard = taskListKeyboard(view.items, locale, {
      source: "tasks",
      scope,
      offset: view.page * PAGE_SIZE,
      page: view.page,
      pages: view.pages,
      rest: view.rest,
      pageCallback: (next) => `tsk:${scope}:${next}`,
    });
    for (const row of taskScopeKeyboard(scope, counts, locale, pausedCount).inline_keyboard) keyboard.row(...row);
    await this.present(ctx, tasksOverviewText(view.items, { scope, total: groups.length, offset: view.page * PAGE_SIZE, locale }), appendFooter(keyboard, locale), edit);
  }

  /**
   * The week plan: the pool with what is taken for this week marked, and what the past week did.
   * Every row is a toggle, so the screen is the state and no separate save step exists.
   */
  async weekPlan_(ctx: AppContext, edit = false, page = 0): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const today = localDateAt(new Date(), settings.timezone);
    const { rows, total, summary } = await this.tasks.listWeekPlanForTelegram(access.workspaceId, today);
    const view = paginate(rows, page, PAGE_SIZE);
    const keyboard = weekPlanKeyboard(
      view.items.map((task) => ({ id: task.id, title: task.title, picked: isPickLive(task.pickedWeekStart, today) })),
      locale,
      { page: view.page, pages: view.pages, rest: view.rest },
    );
    const text = weekPlanText(view.items, { locale, todayLocalDate: today, total, offset: view.page * PAGE_SIZE, summary });
    await this.present(ctx, text, keyboard, edit);
  }

  /**
   * Paused series. They are in no date window, so this is the only screen that shows them and the
   * only place the series can be started again.
   */
  async pausedSeries_(ctx: AppContext, edit = false, page = 0): Promise<void> {
    const { access, locale } = activeState(ctx);
    const { rows, total } = await this.tasks.listPausedSeriesForTelegram(access.workspaceId, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    if (!total) return this.present(ctx, pausedSeriesText([], { locale }), screenFooterKeyboard(locale), edit);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const current = Math.min(page, pages - 1);
    const offset = current * PAGE_SIZE;
    const keyboard = pausedSeriesKeyboard(
      rows.map((task) => ({ id: task.id, title: task.title })),
      locale,
      { page: current, pages, rest: Math.max(0, total - (current + 1) * PAGE_SIZE) },
    );
    await this.present(ctx, pausedSeriesText(rows, { locale, total, offset }), keyboard, edit);
  }

  /** One collapsed line opened up: the dates it stood for, each leading to its own card. */
  async taskGroup(ctx: AppContext, source: GroupSource, key: string, scope?: TaskScope): Promise<boolean> {
    const { access, settings, locale } = activeState(ctx);
    const localDate = localDateAt(new Date(), settings.timezone);
    const groups =
      source === "today"
        ? (await this.tasks.listTodayGroupedForTelegram(access.workspaceId, localDate)).groups
        : (await this.tasks.listGroupedForTelegram(access.workspaceId, { scope: "all", localDate })).groups;
    const group = groups.find((candidate) => candidate.rows.some((row) => (row.occurrence?.id ?? row.task.id) === key));
    if (!group) return false;
    await this.present(ctx, taskGroupText(group, locale), taskGroupKeyboard(group, source, locale, scope), true);
    return true;
  }

  async reminders_(ctx: AppContext, edit = false, page = 0): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const rows = await this.reminders.listUpcoming({ workspaceId: access.workspaceId, userId: access.user.id, limit: 40 });
    if (!rows.length) return this.present(ctx, t(locale, "reminders_none"), screenFooterKeyboard(locale), edit);
    const now = new Date();
    const view = paginate(rows, page, PAGE_SIZE);
    const buttons = view.items.map(({ delivery, task }) => ({
      deliveryId: delivery.id,
      title: task.title,
      when: formatLocalDateTime(delivery.scheduledFor, task.timezone, now),
    }));
    await this.present(
      ctx,
      remindersText(view.items, { locale, timezone: settings.timezone, now }),
      remindersKeyboard(buttons, locale, { page: view.page, pages: view.pages, rest: view.rest }),
      edit,
    );
  }

  async today(ctx: AppContext, edit = false, page = 0): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const now = new Date();
    const localDate = localDateAt(now, settings.timezone);
    const [{ groups, staleCount }, completed] = await Promise.all([
      this.tasks.listTodayGroupedForTelegram(access.workspaceId, localDate),
      this.tasks.listCompletedTodayForTelegram(access.workspaceId, localDate),
    ]);
    const view = paginate(groups, page, PAGE_SIZE);
    const keyboard = taskListKeyboard(view.items, locale, {
      source: "today",
      offset: view.page * PAGE_SIZE,
      page: view.page,
      pages: view.pages,
      rest: view.rest,
      pageCallback: (next) => `tdy:${next}`,
    });
    if (staleCount) keyboard.text(t(locale, "today_stale_button", { count: staleCount }), "tsk:overdue:0").row();
    await this.present(
      ctx,
      todayText(view.items, localDate, { locale, completedCount: completed.length, staleCount, total: groups.length, offset: view.page * PAGE_SIZE, now }),
      appendFooter(keyboard, locale),
      edit,
    );
  }

  async goals(ctx: AppContext, edit = false, scope: GoalScope = "active", page = 0): Promise<void> {
    const { access, locale } = activeState(ctx);
    const items = await this.context.goalsOverview(access.workspaceId, scope);
    const view = paginate(items, page, PAGE_SIZE);
    const keyboard = goalListKeyboard(
      view.items.map(({ goal }) => goal),
      locale,
      { offset: view.page * PAGE_SIZE, page: view.page, pages: view.pages, rest: view.rest, scope },
    );
    for (const row of goalsScopeKeyboard(scope, locale).inline_keyboard) keyboard.row(...row);
    await this.present(ctx, goalsOverviewText(view.items, { scope, total: items.length, offset: view.page * PAGE_SIZE, locale }), appendFooter(keyboard, locale), edit);
  }

  /** One goal with its tasks; the list itself only says how many there are. */
  async goal(ctx: AppContext, goalId: string): Promise<boolean> {
    const { access, locale } = activeState(ctx);
    const row = await this.context.findGoalOverview(access.workspaceId, goalId);
    if (!row) return false;
    const taskButtons = row.tasks.map((task) => ({ id: task.id, title: task.title }));
    await this.present(ctx, goalDetailText(row, locale), goalDetailKeyboard(taskButtons, locale), true);
    return true;
  }

  /** The interface language as four buttons; the same journaled change the /language command makes. */
  async languageChoice(ctx: AppContext): Promise<void> {
    const { locale } = activeState(ctx);
    await this.present(ctx, t(locale, "settings_language_prompt"), languageKeyboard(locale), true);
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

  async showOccurrence(ctx: AppContext, occurrenceId: string, scope?: TaskScope): Promise<boolean> {
    const { access, locale } = activeState(ctx);
    const context = await this.tasks.getOccurrenceContext(access.workspaceId, occurrenceId);
    if (!context) return false;
    await ctx.editMessageText(await this.taskCard(access.workspaceId, context, locale), { reply_markup: taskDetailKeyboard(occurrenceId, locale, scope) }).catch(() => undefined);
    return true;
  }

  /**
   * A task button carries the task, not an occurrence: goals and the no-date filter both lead
   * here. A dated task has a live occurrence to show, so it opens the same card its list line does.
   */
  async showFuzzyTask(ctx: AppContext, taskId: string): Promise<boolean> {
    const { access, locale } = activeState(ctx);
    const task = await this.tasks.getTask(access.workspaceId, taskId);
    if (!task || task.status !== "active") return false;
    if (task.timeMode !== "fuzzy") {
      const current = await this.tasks.findCurrentOccurrences(access.workspaceId, [taskId]);
      const occurrence = current.get(taskId);
      return occurrence ? this.showOccurrence(ctx, occurrence.id) : false;
    }
    const extras = await this.tasks.getTaskCardExtras(access.workspaceId, task.id).catch(() => ({ checklist: [], goalTitle: null }));
    await ctx.editMessageText(fuzzyTaskCardText({ ...task, ...extras }, new Date(), locale), { reply_markup: fuzzyTaskDetailKeyboard(locale) }).catch(() => undefined);
    return true;
  }

  /** The card's own keyboard for its current state, optionally with an Undo row for what just happened. */
  occurrenceKeyboard(ctx: AppContext, context: OccurrenceContext, undoGroupId?: string, undoLabel: "undo_button" | "undo_reschedule_button" = "undo_button"): InlineKeyboard {
    const { locale } = activeState(ctx);
    const keyboard = taskKeyboard(context.occurrence.id, locale);
    if (undoGroupId) keyboard.row().text(t(locale, undoLabel), `act:undo:${undoGroupId}`);
    // The card that replaces a list after an action was the one screen with no way out of it.
    return appendFooter(keyboard.row(), locale);
  }
}
