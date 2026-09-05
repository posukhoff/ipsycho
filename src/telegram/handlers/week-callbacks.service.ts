import { Injectable } from "@nestjs/common";
import { Bot, type CallbackQueryContext } from "grammy";
import { ActionsService } from "../../actions/actions.service.js";
import { SettingsService } from "../../settings/settings.service.js";
import { TasksService } from "../../tasks/tasks.service.js";
import { localDateAt } from "../../core/timezone.js";
import { WEEK_PICK_LIMIT } from "../../core/week-plan.js";
import type { ResolvedAction } from "../../core/ai-actions.js";
import { logger } from "../../observability/logger.js";
import { safeError } from "../../observability/safe-error.js";
import { t } from "../copy/index.js";
import { activeState, type AppContext } from "../telegram-context.js";
import { ScreensService } from "./screens.service.js";
import { removeWeekLine, weekTakeTodayKeyboard } from "../telegram-ui.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const WEEK_TOGGLE_CALLBACK = new RegExp(`^wk:t:(\\d{1,3}):(${UUID})$`);
const WEEK_TAKE_TODAY_CALLBACK = new RegExp(`^wk:d:(${UUID})$`);
const WEEK_PAGE_CALLBACK = /^wk:p:(\d{1,3})$/;

/**
 * The week loop: taking a pool task for the week, putting it back, and taking one into today from
 * the morning briefing. Both are deterministic taps — no model call, and the same tap reverses the
 * pick, so a pick carries no confirmation card and no Undo of its own.
 */
@Injectable()
export class WeekCallbacksService {
  constructor(
    private readonly tasks: TasksService,
    private readonly actions: ActionsService,
    private readonly settings: SettingsService,
    private readonly screens: ScreensService,
  ) {}

  register(bot: Bot<AppContext>): void {
    bot.callbackQuery(WEEK_TOGGLE_CALLBACK, (ctx) => this.toggle(ctx));
    bot.callbackQuery(WEEK_PAGE_CALLBACK, (ctx) => this.page(ctx));
    bot.callbackQuery(WEEK_TAKE_TODAY_CALLBACK, (ctx) => this.takeToday(ctx));
  }

  async toggle(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const match = WEEK_TOGGLE_CALLBACK.exec(ctx.callbackQuery.data);
    const page = match?.[1];
    const taskId = match?.[2];
    if (!taskId || page === undefined) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    const today = localDateAt(new Date(), settings.timezone);
    const result = await this.tasks.togglePickedForWeek(access.workspaceId, taskId, today).catch((error) => {
      logger.error("week toggle failed", { taskId, error: safeError(error) });
      return null;
    });
    if (result === null) return void (await ctx.answerCallbackQuery({ text: t(locale, "week_pick_gone_toast") }));
    if (result === "full") return void (await ctx.answerCallbackQuery({ text: t(locale, "week_full_toast", { limit: WEEK_PICK_LIMIT }) }));
    await ctx.answerCallbackQuery({ text: t(locale, result === "picked" ? "week_picked_toast" : "week_released_toast") });
    // The tap stays on the page it came from: redrawing page one would move the list under the finger.
    await this.screens.weekPlan_(ctx, true, Number(page));
  }

  async page(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { locale } = activeState(ctx);
    const page = WEEK_PAGE_CALLBACK.exec(ctx.callbackQuery.data)?.[1];
    if (page === undefined) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    await ctx.answerCallbackQuery();
    await this.screens.weekPlan_(ctx, true, Number(page));
  }

  /** The morning briefing's tap: the task gets today as its day, which is what "делаю сегодня" means. */
  async takeToday(ctx: CallbackQueryContext<AppContext>): Promise<void> {
    const { access, settings, locale } = activeState(ctx);
    const taskId = WEEK_TAKE_TODAY_CALLBACK.exec(ctx.callbackQuery.data)?.[1];
    if (!taskId) return void (await ctx.answerCallbackQuery({ text: t(locale, "bad_command_toast") }));
    const today = localDateAt(new Date(), settings.timezone);
    const task = await this.tasks.getTask(access.workspaceId, taskId);
    if (!task || task.status !== "active" || task.timeMode !== "fuzzy") {
      return void (await ctx.answerCallbackQuery({ text: t(locale, "week_pick_gone_toast") }));
    }
    const userSettings = await this.settings.get(access.user.id);
    const action: ResolvedAction = {
      type: "reschedule",
      intent: "explicit",
      timezone: task.timezone,
      reviewTime: userSettings?.morningReferenceTime ?? "09:00",
      target: { kind: "task", taskId: task.id, taskVersion: task.version },
      when: { mode: "date", date: today },
      recurrence: null,
      reason: null,
    };
    try {
      await this.actions.applyResolved([action], { workspaceId: access.workspaceId, actorUserId: access.user.id, recipientUserId: access.user.id });
    } catch (error) {
      logger.error("take into today failed", { taskId, error: safeError(error) });
      return void (await ctx.answerCallbackQuery({ text: t(locale, "week_take_today_failed_toast") }));
    }
    await ctx.answerCallbackQuery({ text: t(locale, "week_take_today_toast") });
    // The row it acted on is gone from the week list, so the card must stop offering it.
    const remaining = await this.tasks.listPickedForWeek(access.workspaceId, today);
    const keyboard = weekTakeTodayKeyboard(remaining, locale);
    // The body listed the task too, so editing only the buttons would leave the card contradicting
    // itself: the line stays while its tap is gone.
    const body = ctx.callbackQuery.message?.text;
    const redrawn = body ? removeWeekLine(body, task.title) : null;
    if (redrawn && redrawn !== body) await ctx.editMessageText(redrawn, { reply_markup: keyboard }).catch(() => undefined);
    else await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => undefined);
  }
}
