import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { InlineKeyboard } from "grammy";
import { TaskCardService } from "../../dist/telegram/handlers/task-card.service.js";
import { TelegramService } from "../../dist/telegram/telegram.service.js";
import { appendLaunchButton, launchOnlyKeyboard, quickRescheduleKeyboard, taskKeyboard, webAppLink, webAppPath, weeklyBriefingKeyboard } from "../../dist/telegram/telegram-ui.js";
import { callbackContext } from "./helpers/telegram-harness.mjs";

/**
 * The launch buttons (group 10), re-stated for the bot group 11 left behind.
 *
 * Group 10's claim was that with `WEBAPP_ENABLED` off the bot was byte-for-byte the bot it had
 * always been. Group 11 changed what that claim can mean: the browsing screens are deleted, so the
 * flag no longer restores them. What survives, and what these tests hold, is the narrower and now
 * load-bearing half — **with the flag off nothing offers a button that cannot open**: no `web_app`
 * button anywhere, no dead callback in its place, and no API call at bootstrap.
 */

const APP = "https://app.example.com/app";
const OCCURRENCE_ID = randomUUID();
const TASK_ID = randomUUID();
const GOAL_ID = randomUUID();

/** Every button as `{ text, callback_data | web_app }`, flattened; keyboards are compared as this. */
function shape(keyboard) {
  const rows = keyboard?.inline_keyboard ?? [];
  return rows.map((row) => row.map((button) => ({ text: button.text, ...(button.web_app ? { webApp: button.web_app.url } : { data: button.callback_data }) })));
}

function webAppUrls(keyboard) {
  return shape(keyboard)
    .flat()
    .filter((button) => button.webApp !== undefined)
    .map((button) => button.webApp);
}

function payloads(keyboard) {
  return shape(keyboard)
    .flat()
    .map((button) => button.data)
    .filter((data) => data !== undefined);
}

/**
 * A keyboard with its launch buttons taken back out. Empty rows go with them — and a couple of
 * screens already send an empty row when their list is empty, which is why both sides of every
 * comparison below are normalised the same way rather than one being compared raw.
 */
function withoutLaunchButtons(keyboard) {
  return shape(keyboard)
    .map((row) => row.filter((button) => button.webApp === undefined))
    .filter((row) => row.length > 0);
}

test("with the flag off no keyboard grows a web_app button, whatever else it is told", () => {
  // `null`, `undefined` and an absent argument are the three ways the flag-off path is reached:
  // `ctx.state.webAppUrl` is null, a push reads `config.webAppUrl` which is undefined, and every
  // existing call site simply does not pass the argument at all.
  for (const off of [undefined, null, ""]) {
    const reminder = taskKeyboard(OCCURRENCE_ID, "ru", { snooze: true, webAppUrl: off });
    assert.deepEqual(shape(reminder), shape(taskKeyboard(OCCURRENCE_ID, "ru", { snooze: true })));
    assert.deepEqual(webAppUrls(taskKeyboard(OCCURRENCE_ID, "ru", { snooze: true, recurring: true, webAppUrl: off })), []);
    assert.deepEqual(shape(quickRescheduleKeyboard(OCCURRENCE_ID, "ru", off)), shape(quickRescheduleKeyboard(OCCURRENCE_ID, "ru")));
    assert.deepEqual(shape(weeklyBriefingKeyboard([{ id: GOAL_ID, title: "Запуск" }], "ru", off)), shape(weeklyBriefingKeyboard([{ id: GOAL_ID, title: "Запуск" }], "ru")));
    assert.equal(launchOnlyKeyboard(off, { name: "today" }, "ru"), null);
    assert.deepEqual(shape(appendLaunchButton(new InlineKeyboard().text("x", "act:undo:1"), off, { name: "today" }, "ru")), [[{ text: "x", data: "act:undo:1" }]]);
  }
});

test("the flag-off reminder card is the surviving reactions and nothing that cannot open", () => {
  // Pinned literally: this is the keyboard production sends with the app off, and «⚙️ Ещё» and
  // «📅 Другая дата» are gone from it for good — their two-step flows are sheets in the app now,
  // and the flag being off does not bring a handler for them back (task 11.3).
  assert.deepEqual(shape(taskKeyboard(OCCURRENCE_ID, "ru", { snooze: true, mute: true, recurring: true })), [
    [{ text: "✅ Готово", data: `occ:done:${OCCURRENCE_ID}` }],
    [
      { text: "⏰ Через 15 мин", data: `follow:snooze:15m:${OCCURRENCE_ID}` },
      { text: "⏰ Через час", data: `follow:snooze:1h:${OCCURRENCE_ID}` },
    ],
    [{ text: "⏭ Пропустить это", data: `occ:skip:${OCCURRENCE_ID}` }],
    [{ text: "🕒 Позже", data: `occ:resched:${OCCURRENCE_ID}` }],
    [{ text: "🔕 Хватит по этой задаче", data: `rem:mute:${OCCURRENCE_ID}` }],
  ]);
  assert.deepEqual(shape(quickRescheduleKeyboard(OCCURRENCE_ID, "ru")), [
    [
      { text: "+1 час", data: `resched:1h:${OCCURRENCE_ID}` },
      { text: "Вечером", data: `resched:evening:${OCCURRENCE_ID}` },
    ],
    [{ text: "Завтра", data: `resched:tomorrow:${OCCURRENCE_ID}` }],
    [{ text: "← Назад", data: `occ:back:${OCCURRENCE_ID}` }],
  ]);
});

test("a launch link puts the id in the fragment and points at a screen the client registers", () => {
  assert.equal(webAppLink(APP, { name: "task", id: OCCURRENCE_ID }), `${APP}/#/task/${OCCURRENCE_ID}`);
  assert.equal(webAppLink(`${APP}/`, { name: "today" }), `${APP}/#/today`, "a trailing slash must not become a second path segment");
  assert.equal(webAppLink(null, { name: "today" }), null);

  const screens = [
    { name: "today" },
    { name: "tasks", scope: "overdue" },
    { name: "task", id: OCCURRENCE_ID },
    { name: "week" },
    { name: "goals", scope: "active" },
    { name: "reminders" },
    { name: "settings" },
    { name: "memory" },
    { name: "profile" },
  ];

  // The client parses the fragment; a link into a screen it does not register would open a
  // not-found in someone's hand, and only the two files agreeing prevents that.
  const routes = readFileSync("web/src/app/routes.ts", "utf8");
  const registered = new Set([...routes.matchAll(/case "([a-z]+)":/gu)].map(([, name]) => name));
  assert.ok(registered.size >= 10, "the route table could not be read");

  for (const screen of screens) {
    const link = webAppLink(APP, screen);
    const [, fragment] = link.split("#");
    assert.equal(fragment, webAppPath(screen));
    assert.ok(fragment.startsWith("/"), fragment);
    const head = fragment.split("/")[1];
    assert.ok(registered.has(head), `${fragment} is not a route web/src/app/routes.ts registers`);
    // The id never leaves the fragment: no query, and nothing before the `#` but the origin.
    assert.equal(link.split("#")[0], `${APP}/`);
    assert.ok(!link.includes("?"), link);
  }
});

test("with the flag on the reminder card gains a launch button and keeps every reaction", () => {
  const on = taskKeyboard(OCCURRENCE_ID, "ru", { snooze: true, mute: true, webAppUrl: APP });
  assert.deepEqual(webAppUrls(on), [`${APP}/#/task/${OCCURRENCE_ID}`]);
  assert.ok(!payloads(on).includes(`occ:more:${OCCURRENCE_ID}`), "«Ещё» is deleted, not hidden");
  assert.deepEqual(payloads(on), [
    `occ:done:${OCCURRENCE_ID}`,
    `follow:snooze:15m:${OCCURRENCE_ID}`,
    `follow:snooze:1h:${OCCURRENCE_ID}`,
    `occ:resched:${OCCURRENCE_ID}`,
    `rem:mute:${OCCURRENCE_ID}`,
  ]);
  // The launch button sits where «Ещё» was, next to «Позже», not on a row of its own.
  assert.deepEqual(shape(on).at(-2), [
    { text: "🕒 Позже", data: `occ:resched:${OCCURRENCE_ID}` },
    { text: "📲 Открыть задачу", webApp: `${APP}/#/task/${OCCURRENCE_ID}` },
  ]);

  // A repeat could only be skipped from behind «Ещё». With «Ещё» gone the card offers it directly,
  // whether or not the app is on — there is no longer anywhere else for it to live.
  assert.ok(payloads(taskKeyboard(OCCURRENCE_ID, "ru", { snooze: true, recurring: true })).includes(`occ:skip:${OCCURRENCE_ID}`));
  const repeat = taskKeyboard(OCCURRENCE_ID, "ru", { snooze: true, recurring: true, webAppUrl: APP });
  assert.ok(payloads(repeat).includes(`occ:skip:${OCCURRENCE_ID}`));
  assert.ok(!payloads(taskKeyboard(OCCURRENCE_ID, "ru", { snooze: true, webAppUrl: APP })).includes(`occ:skip:${OCCURRENCE_ID}`), "a one-off has nothing to skip");
});

test("the three quick moves stay in chat, and the arbitrary date is only the launch button", () => {
  const on = quickRescheduleKeyboard(OCCURRENCE_ID, "ru", APP);
  assert.deepEqual(payloads(on), [`resched:1h:${OCCURRENCE_ID}`, `resched:evening:${OCCURRENCE_ID}`, `resched:tomorrow:${OCCURRENCE_ID}`, `occ:back:${OCCURRENCE_ID}`]);
  assert.deepEqual(webAppUrls(on), [`${APP}/#/task/${OCCURRENCE_ID}`]);
  assert.ok(!payloads(on).includes(`resched:custom:${OCCURRENCE_ID}`));
});

test("the morning card is a launch button, and the week card keeps its goal steps", () => {
  // The morning card's «делаю сегодня» rows were a list of up to eight taps — browsing, so they
  // are the day's screen in the app now and the card carries only the way in (task 11.3, `wk:d`).
  assert.deepEqual(webAppUrls(launchOnlyKeyboard(APP, { name: "today" }, "ru")), [`${APP}/#/today`]);

  const weekly = weeklyBriefingKeyboard([{ id: GOAL_ID, title: "Запуск" }], "ru", APP);
  assert.deepEqual(withoutLaunchButtons(weekly), withoutLaunchButtons(weeklyBriefingKeyboard([{ id: GOAL_ID, title: "Запуск" }], "ru")));
  assert.deepEqual(webAppUrls(weekly), [`${APP}/#/week`]);
  // The goal-step row is a conversation turn with a shortcut, so it stays in chat (design.md § 1).
  assert.ok(payloads(weekly).includes(`goal:step:${GOAL_ID}`));
});

test("a push carries the launch button only when the flag is on", async () => {
  const sent = [];
  const telegram = Object.create(TelegramService.prototype);
  telegram.bot = {
    api: {
      sendMessage: async (_chat, text, extra) => {
        sent.push({ text, markup: extra?.reply_markup });
        return { message_id: sent.length };
      },
    },
  };

  telegram.config = { webAppEnabled: false, webAppUrl: undefined };
  await telegram.sendReminder(777, "напоминание", OCCURRENCE_ID, "ru", { recurring: true });
  await telegram.sendBriefing(777, "morning", "утро", "ru", []);
  await telegram.sendBriefing(777, "weekly", "неделя", "ru", [{ id: GOAL_ID, title: "Запуск" }]);
  assert.deepEqual(
    sent.flatMap((message) => webAppUrls(message.markup)),
    [],
    "flag off: nothing offers to open an app that is not there",
  );

  // A URL left in the environment after the flag was turned off must not leak buttons either.
  sent.length = 0;
  telegram.config = { webAppEnabled: false, webAppUrl: APP };
  await telegram.sendReminder(777, "напоминание", OCCURRENCE_ID, "ru", {});
  assert.deepEqual(webAppUrls(sent[0].markup), []);

  sent.length = 0;
  telegram.config = { webAppEnabled: true, webAppUrl: APP };
  await telegram.sendReminder(777, "напоминание", OCCURRENCE_ID, "ru", { mute: true, recurring: true });
  await telegram.sendBriefing(777, "morning", "утро", "ru", []);
  await telegram.sendBriefing(777, "weekly", "неделя", "ru", [{ id: GOAL_ID, title: "Запуск" }]);
  assert.deepEqual(
    sent.flatMap((message) => webAppUrls(message.markup)),
    [`${APP}/#/task/${OCCURRENCE_ID}`, `${APP}/#/today`, `${APP}/#/week`],
  );
  assert.ok(payloads(sent[0].markup).includes(`rem:mute:${OCCURRENCE_ID}`), "an escalation keeps its mute");
});

test("the chat menu button is set at bootstrap only when the flag is on, and is never unset", async () => {
  const calls = [];
  const telegram = Object.create(TelegramService.prototype);
  telegram.bot = { api: { setChatMenuButton: async (payload) => void calls.push(payload) } };

  // Called directly: the rest of `onApplicationBootstrap` starts long polling. This is the one
  // bootstrap step the flag governs, and with the flag off it must make no API call whatsoever —
  // not `{"type":"commands"}` either. Turning the flag off later leaves the stored button alone;
  // resetting it is a documented step of the rollback in docs/DEPLOYMENT.md § 7.
  telegram.config = { webAppEnabled: false, webAppUrl: APP, botIdentity: "test" };
  await telegram.publishChatMenuButton();
  assert.deepEqual(calls, []);

  telegram.config = { webAppEnabled: true, webAppUrl: APP, botIdentity: "test" };
  await telegram.publishChatMenuButton();
  assert.deepEqual(calls, [{ menu_button: { type: "web_app", text: "Открыть", web_app: { url: APP } } }]);
});

test("the access middleware carries the flag onto every update, and null when it is off", async () => {
  const botInfo = {
    id: 1,
    is_bot: true,
    first_name: "b",
    username: "b",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
  const updates = { claim: async () => true, markHandled: async () => undefined, markLost: async () => 0 };
  const access = {
    resolveActiveUser: async (id) => ({ user: { id: `u${id}`, aiStatus: "enabled", telegramUserId: id }, workspaceId: `w${id}` }),
    findRestorable: async () => null,
  };
  const settings = { get: async () => ({ timezone: "Europe/Kyiv", pinnedLanguage: null, telegramLanguage: null }), rememberTelegramLanguage: async () => undefined };

  const seen = [];
  const run = async (config) => {
    const service = new TelegramService({ telegramBotToken: "123456:test-token-with-enough-length-abcdef", botIdentity: "test", ...config }, updates, access, settings);
    service.bot.botInfo = botInfo;
    service.bot.use((ctx) => void seen.push(ctx.state.webAppUrl));
    await service.bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 100, type: "private", first_name: "u" },
        from: { id: 100, is_bot: false, first_name: "u", language_code: "ru" },
        text: "привет",
      },
    });
  };

  await run({ webAppEnabled: false });
  await run({ webAppEnabled: false, webAppUrl: APP });
  await run({ webAppEnabled: true, webAppUrl: APP });
  assert.deepEqual(seen, [null, null, APP]);
});

/**
 * The card the chat still draws after a reaction. `ScreensService` is gone with the screens; what
 * a reminder, a completed reschedule and a typed reason share is this one card (task 11.5).
 */
function taskCard() {
  return new TaskCardService({ getTaskCardExtras: async () => ({ checklist: [], goalTitle: null }) }, { nextUserReminderAt: async () => null });
}

test("the card left after a reminder action keeps the shape the push had", () => {
  const context = { task: { id: TASK_ID, recurrenceRule: "FREQ=DAILY" }, occurrence: { id: OCCURRENCE_ID } };
  const off = taskCard().keyboard(callbackContext("occ:back:x"), context);
  assert.deepEqual(webAppUrls(off), []);
  assert.ok(!payloads(off).includes(`occ:more:${OCCURRENCE_ID}`), "«Ещё» has no handler left to open");
  assert.ok(payloads(off).includes(`occ:skip:${OCCURRENCE_ID}`), "the series can still be skipped");

  const on = taskCard().keyboard(callbackContext("occ:back:x", { webAppUrl: APP }), context);
  assert.deepEqual(webAppUrls(on), [`${APP}/#/task/${OCCURRENCE_ID}`]);
  assert.deepEqual(withoutLaunchButtons(on), withoutLaunchButtons(off), "the app only adds a way in; it changes no reaction");

  // An Undo row is the one thing that may follow the card, and it is a reaction, not a screen.
  const undone = taskCard().keyboard(callbackContext("occ:back:x", { webAppUrl: APP }), context, "group-1", "undo_reschedule_button");
  assert.ok(payloads(undone).includes("act:undo:group-1"));
});
