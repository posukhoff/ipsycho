import { Injectable } from "@nestjs/common";
import { InlineKeyboard, type Bot, type CallbackQueryContext, type CommandContext } from "grammy";
import { t } from "../copy/index.js";
import { activeState, type AppContext } from "../telegram-context.js";
import { launchOnlyKeyboard, type WebAppScreen } from "../telegram-webapp.js";

/**
 * One release of grace for the browsing surface that moved into the Mini App.
 *
 * The screens are gone (task 11), but their entry points are not: Telegram keeps an old command in
 * the client's menu until `setMyCommands` propagates, and a card drawn last month still sits in
 * someone's scroll-back with live buttons on it. An unanswered `callback_query` leaves a spinner on
 * the user's screen forever, so **every** removed pattern still answers here — one sentence saying
 * where that thing lives now, plus the launch button into the screen it became.
 *
 * With `WEBAPP_ENABLED` off there is no launch button to build, and the sentence has to stand on
 * its own: it names the app and points back at the conversation, which is the surface that never
 * moved. That is why the copy says both things in one line instead of "tap the button below".
 *
 * This file is the whole deprecation. Deleting it next release removes the grace period and
 * nothing else.
 */
@Injectable()
export class MovedToAppService {
  register(bot: Bot<AppContext>): void {
    for (const [command, screen] of MOVED_COMMANDS) bot.command(command, (ctx) => this.command(ctx, screen));
    for (const { pattern, screen } of MOVED_CALLBACKS) bot.callbackQuery(pattern, (ctx) => this.callback(ctx, pattern, screen));
  }

  private async command(ctx: CommandContext<AppContext>, screen: WebAppScreen): Promise<void> {
    const { locale, webAppUrl } = activeState(ctx);
    const launch = launchOnlyKeyboard(webAppUrl, screen, locale);
    await ctx.reply(t(locale, "moved_to_app"), launch ? { reply_markup: launch } : {});
  }

  private async callback(ctx: CallbackQueryContext<AppContext>, pattern: RegExp, screen: ScreenFor): Promise<void> {
    const { locale, webAppUrl } = activeState(ctx);
    // The toast first and unconditionally: it is the only part that clears the spinner.
    await ctx.answerCallbackQuery({ text: t(locale, "moved_to_app_toast") }).catch(() => undefined);
    // The card it came from is a screen that no longer exists; it must stop inviting the same tap.
    // Telegram refuses to edit a message older than 48 h, which is exactly the case this exists for.
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    const target = typeof screen === "function" ? screen(pattern.exec(ctx.callbackQuery.data)) : screen;
    const launch = launchOnlyKeyboard(webAppUrl, target, locale);
    await ctx.reply(t(locale, "moved_to_app"), launch ? { reply_markup: launch } : {}).catch(() => undefined);
  }
}

type ScreenFor = WebAppScreen | ((match: RegExpExecArray | null) => WebAppScreen);

const TASKS: WebAppScreen = { name: "tasks", scope: "week" };
const ALL_TASKS: WebAppScreen = { name: "tasks", scope: "all" };
const GOALS: WebAppScreen = { name: "goals", scope: "active" };

/** Section 11.1: every command that is now a screen in the app. */
const MOVED_COMMANDS: ReadonlyArray<readonly [string, WebAppScreen]> = [
  ["tasks", TASKS],
  ["task", TASKS],
  ["today", { name: "today" }],
  ["week", { name: "week" }],
  ["goals", GOALS],
  ["reminders", { name: "reminders" }],
  ["settings", { name: "settings" }],
  ["memory", { name: "memory" }],
  ["timezone", { name: "settings" }],
  ["language", { name: "settings" }],
  ["morning", { name: "settings" }],
  ["weekly", { name: "settings" }],
  ["quiet", { name: "settings" }],
  ["snooze", { name: "settings" }],
  ["reminder_defaults", { name: "settings" }],
];

const UUID = "[0-9a-f-]{36}";

/**
 * Section 11.3: every callback pattern the screens used to register. The occurrence-shaped ones
 * carry the id they were drawn with, so the button opens that task rather than a list — the id is
 * a hint, and the API answers `not_found` for one that is not the user's (design.md § 2).
 */
const MOVED_CALLBACKS: ReadonlyArray<{ pattern: RegExp; screen: ScreenFor }> = [
  { pattern: /^nav:(today|tasks|reminders|settings|goals|week)$/, screen: (match) => navScreen(match?.[1]) },
  { pattern: /^tsk:(overdue|today|week|month|all|nodate):(\d{1,3})$/, screen: TASKS },
  { pattern: /^tdy:(\d{1,3})$/, screen: { name: "today" } },
  { pattern: new RegExp(`^grp:(t|d):(${UUID})(?::(overdue|today|week|month|all|nodate))?$`), screen: TASKS },
  {
    pattern: new RegExp(`^view:(occ|task):(${UUID})(?::(overdue|today|week|month|all|nodate))?$`),
    screen: (match) => occurrenceScreen(match?.[1] === "occ" ? match[2] : undefined),
  },
  { pattern: /^gl:(active|paused|completed):(\d{1,3})$/, screen: GOALS },
  { pattern: new RegExp(`^goal:(${UUID})$`), screen: GOALS },
  { pattern: /^paused:(\d{1,3})$/, screen: ALL_TASKS },
  { pattern: /^wk:t:(\d{1,3}):[0-9a-f-]{36}$/, screen: { name: "week" } },
  { pattern: /^wk:p:(\d{1,3})$/, screen: { name: "week" } },
  { pattern: new RegExp(`^wk:d:(${UUID})$`), screen: { name: "today" } },
  { pattern: /^rem:p:(\d{1,3})$/, screen: { name: "reminders" } },
  { pattern: new RegExp(`^rem:cancel:(${UUID})$`), screen: { name: "reminders" } },
  { pattern: /^prefs:(morning|weekly|quiet|snooze):(toggle|morning)$/, screen: { name: "settings" } },
  { pattern: /^prefs:lang:(open|auto|ru|uk|en)$/, screen: { name: "settings" } },
  { pattern: /^prefs:tz:open$/, screen: { name: "settings" } },
  { pattern: /^tzapply:(digests|quiet|both|keep)$/, screen: { name: "settings" } },
  { pattern: /^profile:open$/, screen: { name: "profile" } },
  { pattern: /^history:clear$/, screen: { name: "settings" } },
  { pattern: /^guide:(help|index|tasks|goals|reminders|reports|ai)$/, screen: TASKS },
  { pattern: new RegExp(`^occ:(more|cancel|cancel_one):(${UUID})$`), screen: (match) => occurrenceScreen(match?.[2]) },
  { pattern: new RegExp(`^series:(pause|resume|cancel):(${UUID})$`), screen: ALL_TASKS },
  { pattern: new RegExp(`^resched:custom:(${UUID})$`), screen: (match) => occurrenceScreen(match?.[1]) },
];

function navScreen(target: string | undefined): WebAppScreen {
  if (target === "today") return { name: "today" };
  if (target === "reminders") return { name: "reminders" };
  if (target === "settings") return { name: "settings" };
  if (target === "goals") return GOALS;
  if (target === "week") return { name: "week" };
  return TASKS;
}

/** The task sheet when the button carried an occurrence id, the list when it did not. */
function occurrenceScreen(occurrenceId: string | undefined): WebAppScreen {
  return occurrenceId ? { name: "task", id: occurrenceId } : TASKS;
}
