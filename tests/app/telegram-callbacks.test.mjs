import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { TaskCallbacksService } from "../../dist/telegram/handlers/task-callbacks.service.js";
import { MovedToAppService } from "../../dist/telegram/handlers/moved-to-app.service.js";
import { SystemCommandsService } from "../../dist/telegram/handlers/system-commands.service.js";
import { OnboardingService } from "../../dist/telegram/handlers/onboarding.service.js";
import { quickRescheduleKeyboard, quickRescheduleReasonKeyboard, taskKeyboard, weeklyBriefingKeyboard } from "../../dist/telegram/telegram-ui.js";
import { buttonsOf, callbackContext, lastButtons } from "./helpers/telegram-harness.mjs";

const OCCURRENCE_ID = randomUUID();
const TASK_ID = randomUUID();
const GROUP_ID = randomUUID();
const GOAL_UUID = randomUUID();
const APP = "https://ipsycho.example/app";

/**
 * Every pattern the bot still registers. A generated payload that matches none of them is a dead
 * button — and after task 11 the list is short on purpose: the reaction cards, the deterministic
 * gates and the onboarding flow. The removed screens' patterns are asserted separately, further
 * down, because they must answer without being live behaviour.
 */
const ROUTES = [
  /^occ:(done|skip|resched|back):[0-9a-f-]{36}$/,
  /^resched:(1h|evening|tomorrow):[0-9a-f-]{36}$/,
  /^rr:(h|e|t):(t|d|e|o):[0-9a-f-]{36}$/,
  /^follow:snooze:(15m|1h):[0-9a-f-]{36}$/,
  /^rem:mute:[0-9a-f-]{36}$/,
  /^act:(confirm|cancel|undo):[0-9a-f-]{36}$/,
  /^onb:(tz|digests|quiet|weekly):([A-Za-z_/+-]+|on|off|default|other)$/,
  /^goal:step:[0-9a-f-]{36}$/,
  /^account:delete_confirm$/,
  /^ai:(consent|decline)$/,
  /^voice:(consent|decline)$/,
];

const KEYBOARDS = {
  reminderCard: taskKeyboard(OCCURRENCE_ID, "ru", { snooze: true, mute: true, recurring: true }),
  reminderCardWithApp: taskKeyboard(OCCURRENCE_ID, "ru", { snooze: true, mute: true, recurring: true, webAppUrl: APP }),
  quickRescheduleKeyboard: quickRescheduleKeyboard(OCCURRENCE_ID, "ru"),
  quickRescheduleKeyboardWithApp: quickRescheduleKeyboard(OCCURRENCE_ID, "ru", APP),
  quickRescheduleReasonKeyboard: quickRescheduleReasonKeyboard(OCCURRENCE_ID, "tomorrow", "ru"),
  weeklyBriefingKeyboard: weeklyBriefingKeyboard([{ id: GOAL_UUID, title: "Запустить первую платную группу с очень длинным названием" }], "ru"),
};

test("every generated callback payload fits Telegram's 64-byte limit and is routed by a registered handler", () => {
  for (const [name, keyboard] of Object.entries(KEYBOARDS)) {
    const payloads = buttonsOf(keyboard).filter(Boolean);
    assert.ok(payloads.length, `${name} produced no callback buttons`);
    for (const payload of payloads) {
      assert.ok(Buffer.byteLength(payload, "utf8") <= 64, `${name}: ${payload} is ${Buffer.byteLength(payload, "utf8")} bytes`);
      assert.ok(
        ROUTES.some((route) => route.test(payload)),
        `${name}: ${payload} matches no registered handler`,
      );
    }
  }
});

/**
 * The reminder card is the product's most-used surface and the cleanup was not supposed to touch
 * it, so its buttons are pinned exactly — in both flag states, because the app being off must not
 * bring «⚙️ Ещё» and its two-step flows back into chat.
 */
test("the reminder card is exactly the surviving reaction buttons, with or without the app", () => {
  const expected = [
    `occ:done:${OCCURRENCE_ID}`,
    `follow:snooze:15m:${OCCURRENCE_ID}`,
    `follow:snooze:1h:${OCCURRENCE_ID}`,
    `occ:skip:${OCCURRENCE_ID}`,
    `occ:resched:${OCCURRENCE_ID}`,
    `rem:mute:${OCCURRENCE_ID}`,
  ];
  assert.deepEqual(buttonsOf(KEYBOARDS.reminderCard), expected);
  // With the app on the card gains exactly one `web_app` button and keeps every callback it had.
  assert.deepEqual(buttonsOf(KEYBOARDS.reminderCardWithApp).filter(Boolean), expected);
  assert.deepEqual(webAppUrls(KEYBOARDS.reminderCardWithApp), [`${APP}/#/task/${OCCURRENCE_ID}`]);

  // The three quick moves and the way back; «📅 Другая дата» is a sheet in the app, never a button.
  assert.deepEqual(buttonsOf(KEYBOARDS.quickRescheduleKeyboard), [
    `resched:1h:${OCCURRENCE_ID}`,
    `resched:evening:${OCCURRENCE_ID}`,
    `resched:tomorrow:${OCCURRENCE_ID}`,
    `occ:back:${OCCURRENCE_ID}`,
  ]);
  assert.deepEqual(buttonsOf(KEYBOARDS.quickRescheduleKeyboardWithApp).filter(Boolean), buttonsOf(KEYBOARDS.quickRescheduleKeyboard));
});

function webAppUrls(keyboard) {
  return keyboard.inline_keyboard
    .flat()
    .map((button) => button.web_app?.url)
    .filter(Boolean);
}

function service(overrides = {}) {
  const applied = [];
  const muted = [];
  const tasks = {
    getOccurrenceContext: async () => overrides.context ?? null,
    getTask: async () => null,
    recordInteraction: async () => undefined,
    getTaskCardExtras: async () => ({ checklist: [], goalTitle: null }),
    ...overrides.tasks,
  };
  const actions = {
    validateResolved: async () => overrides.issues ?? [],
    applyResolved: async (resolved) => {
      applied.push(resolved);
      if (overrides.applyThrows) throw overrides.applyThrows;
      return { groupId: GROUP_ID, items: [], undoable: true };
    },
    ...overrides.actions,
  };
  const reminders = { muteDefaultReminders: async (input) => void muted.push(input) };
  const settings = { get: async () => ({ version: 1, morningReferenceTime: "09:00" }), setPendingInput: async () => undefined };
  const card = { text: async () => "карточка", keyboard: () => new InlineKeyboard().text("ok", `occ:done:${OCCURRENCE_ID}`) };
  return { service: new TaskCallbacksService(tasks, reminders, settings, actions, card), applied, muted };
}

const context = {
  task: { id: TASK_ID, version: 1, title: "Позвонить клиенту", recurrenceRule: null, importance: "normal", kind: "task", status: "active" },
  occurrence: { id: OCCURRENCE_ID, version: 1, status: "open", timezone: "Europe/Kyiv" },
};

test("a button for an occurrence that no longer exists says so and takes the keyboard away", async () => {
  const { service: handler } = service({ context: null });
  const ctx = callbackContext(`occ:done:${OCCURRENCE_ID}`);
  await handler.occurrence(ctx);
  assert.match(ctx.answers[0], /\S/);
  assert.deepEqual(lastButtons(ctx), []);
});

test("a malformed payload is answered, not acted on", async () => {
  const { service: handler, applied } = service({ context });
  const ctx = callbackContext("occ:done:not-a-uuid");
  await handler.occurrence(ctx);
  assert.equal(applied.length, 0);
  assert.match(ctx.answers[0], /\S/);
});

test("Done journals one explicit set_task_state and offers Undo for that group", async () => {
  const { service: handler, applied } = service({ context });
  const ctx = callbackContext(`occ:done:${OCCURRENCE_ID}`);
  await handler.occurrence(ctx);
  assert.equal(applied.length, 1);
  const [action] = applied[0];
  assert.equal(action.type, "set_task_state");
  assert.equal(action.intent, "explicit");
  assert.equal(action.state, "done");
  assert.equal(action.target.occurrenceId, OCCURRENCE_ID);
  assert.deepEqual(lastButtons(ctx), [`act:undo:${GROUP_ID}`]);
});

test("a second tap on an already terminal occurrence changes nothing and reports the state instead", async () => {
  const done = { ...context, occurrence: { ...context.occurrence, status: "done" } };
  const { service: handler, applied } = service({ context: done, applyThrows: new Error("terminal occurrence cannot be changed") });
  const ctx = callbackContext(`occ:done:${OCCURRENCE_ID}`);
  await handler.occurrence(ctx);
  assert.equal(applied.length, 1);
  assert.match(ctx.answers[0], /\S/);
  assert.deepEqual(lastButtons(ctx), []);
});

test("Back and Later only swap the keyboard, they never write", async () => {
  const { service: handler, applied } = service({ context });
  const back = callbackContext(`occ:back:${OCCURRENCE_ID}`);
  await handler.occurrence(back);
  assert.equal(applied.length, 0);
  assert.ok(lastButtons(back).includes(`occ:done:${OCCURRENCE_ID}`));

  const later = callbackContext(`occ:resched:${OCCURRENCE_ID}`);
  await handler.occurrence(later);
  assert.equal(applied.length, 0);
  assert.ok(lastButtons(later).includes(`resched:tomorrow:${OCCURRENCE_ID}`));
});

test("«Хватит по этой задаче» mutes that occurrence and leaves the card its own buttons", async () => {
  const { service: handler, muted } = service({ context });
  const ctx = callbackContext(`rem:mute:${OCCURRENCE_ID}`);
  await handler.muteReminders(ctx);
  assert.deepEqual(muted, [{ workspaceId: "ws-1", userId: "user-1", occurrenceId: OCCURRENCE_ID }]);
  assert.match(ctx.answers[0], /\S/);
  assert.deepEqual(lastButtons(ctx), [`occ:done:${OCCURRENCE_ID}`]);
});

test("a card whose text Telegram refuses to edit still loses its buttons", async () => {
  const { service: handler } = service({ context });
  const ctx = callbackContext(`occ:done:${OCCURRENCE_ID}`, { editFails: true });
  await handler.occurrence(ctx);
  assert.match(ctx.answers[0], /\S/);
});

/**
 * The screens are gone; their buttons are still in scroll-back. An unanswered `callback_query`
 * leaves a spinner on the user's screen forever, so the deletion is only safe if every removed
 * pattern still answers — with the app on and with it off.
 */
function movedRoutes() {
  const commands = new Map();
  const callbacks = [];
  const bot = {
    command: (name, handler) => commands.set(name, handler),
    callbackQuery: (pattern, handler) => callbacks.push({ pattern, handler }),
  };
  new MovedToAppService().register(bot);
  return { commands, callbacks };
}

const REMOVED_PAYLOADS = [
  "nav:today",
  "nav:settings",
  "tsk:overdue:0",
  "tdy:2",
  `grp:t:${OCCURRENCE_ID}:week`,
  `view:occ:${OCCURRENCE_ID}`,
  `view:task:${TASK_ID}:nodate`,
  "gl:paused:1",
  `goal:${GOAL_UUID}`,
  "paused:0",
  `wk:t:0:${TASK_ID}`,
  "wk:p:1",
  `wk:d:${TASK_ID}`,
  "rem:p:3",
  `rem:cancel:${OCCURRENCE_ID}`,
  "prefs:morning:toggle",
  "prefs:lang:open",
  "prefs:tz:open",
  "tzapply:both",
  "profile:open",
  "history:clear",
  "guide:index",
  `occ:more:${OCCURRENCE_ID}`,
  `occ:cancel:${OCCURRENCE_ID}`,
  `occ:cancel_one:${OCCURRENCE_ID}`,
  `series:pause:${TASK_ID}`,
  `resched:custom:${OCCURRENCE_ID}`,
];

const REMOVED_COMMANDS = [
  "tasks",
  "task",
  "today",
  "week",
  "goals",
  "reminders",
  "settings",
  "memory",
  "timezone",
  "language",
  "morning",
  "weekly",
  "quiet",
  "snooze",
  "reminder_defaults",
];

test("a removed callback answers with a sentence and a launch button instead of falling silent", async () => {
  const { callbacks } = movedRoutes();
  for (const data of REMOVED_PAYLOADS) {
    const route = callbacks.find(({ pattern }) => pattern.test(data));
    assert.ok(route, `${data} matches no handler: an old button would spin forever`);
    const ctx = callbackContext(data, { webAppUrl: APP });
    await route.handler(ctx);
    assert.match(ctx.answers[0] ?? "", /\S/, `${data} left the spinner running`);
    assert.deepEqual(lastButtons(ctx), [], `${data} left the dead screen's keyboard in place`);
    const reply = ctx.replies.at(-1);
    assert.match(reply.text, /\S/);
    assert.equal(webAppUrls(reply.markup).length, 1, `${data} answered without a way into the app`);
  }
});

test("with the app off the same button still answers, with a sentence and no broken button", async () => {
  const { callbacks } = movedRoutes();
  for (const data of REMOVED_PAYLOADS) {
    const route = callbacks.find(({ pattern }) => pattern.test(data));
    const ctx = callbackContext(data);
    await route.handler(ctx);
    assert.match(ctx.answers[0] ?? "", /\S/, `${data} left the spinner running with WEBAPP_ENABLED off`);
    const reply = ctx.replies.at(-1);
    assert.match(reply.text, /\S/);
    assert.equal(reply.markup, null, `${data} offered a button that cannot exist with the app off`);
  }
});

test("a card's own id survives into the launch button, so an old task button opens that task", async () => {
  const { callbacks } = movedRoutes();
  const data = `occ:more:${OCCURRENCE_ID}`;
  const route = callbacks.find(({ pattern }) => pattern.test(data));
  const ctx = callbackContext(data, { webAppUrl: APP });
  await route.handler(ctx);
  assert.deepEqual(webAppUrls(ctx.replies.at(-1).markup), [`${APP}/#/task/${OCCURRENCE_ID}`]);
});

test("every removed command answers for one release, and none of the surviving ones is shadowed", async () => {
  const { commands } = movedRoutes();
  assert.deepEqual([...commands.keys()].sort(), [...REMOVED_COMMANDS].sort());
  for (const kept of ["start", "help", "context", "status", "clear", "cancel", "retry_ai", "invite", "delete_account", "restore", "ai_revoke"]) {
    assert.ok(!commands.has(kept), `${kept} must stay a real command, not an "it moved" answer`);
  }
  const ctx = callbackContext("unused", { webAppUrl: APP });
  await commands.get("tasks")(ctx);
  assert.match(ctx.replies.at(-1).text, /\S/);
  assert.equal(webAppUrls(ctx.replies.at(-1).markup).length, 1);
});

/**
 * `/context` is the one command that survived the cleanup by being read correctly: it asks the
 * model and answers in chat, so it is a conversation turn, not the screen it also used to open.
 * The app's profile is a read-only view of what this interview writes — deleting the command would
 * have left nothing that writes it.
 */
function systemCommands() {
  const started = [];
  const replied = [];
  const commands = new Map();
  const chat = {
    startProfile: async (input) => {
      started.push(input);
      return { kind: "reply", text: "Какой у тебя обычно режим дня?" };
    },
  };
  const chatReply = { reply: async (_ctx, _access, result) => void replied.push(result) };
  const bot = { command: (name, handler) => commands.set(name, handler), callbackQuery: () => undefined };
  new SystemCommandsService({}, {}, {}, {}, chat, {}, {}, chatReply, {}, {}).register(bot);
  return { commands, started, replied };
}

test("/context starts the profile interview in chat, whether or not the app is on", async () => {
  const withApp = systemCommands();
  assert.ok(withApp.commands.has("context"), "the interview has no other entry point");
  const on = callbackContext("unused", { webAppUrl: APP });
  await withApp.commands.get("context")(on);
  assert.deepEqual(
    withApp.started.map(({ workspaceId, userId }) => ({ workspaceId, userId })),
    [{ workspaceId: "ws-1", userId: "user-1" }],
  );
  assert.equal(withApp.replied.length, 1, "the model's turn is what answers the command");
  // The interview writes and the screen reads, so the turn is followed by the way to the screen.
  assert.equal(on.replies.length, 1);
  assert.deepEqual(webAppUrls(on.replies[0].markup), [`${APP}/#/profile`]);

  const withoutApp = systemCommands();
  const off = callbackContext("unused");
  await withoutApp.commands.get("context")(off);
  assert.equal(withoutApp.started.length, 1, "the interview does not depend on the app being on");
  assert.equal(withoutApp.replied.length, 1);
  assert.equal(off.replies.length, 0, "with no screen to open there is no second message and no dead button");
});

test("a typed yes answers an onboarding step instead of going to the model", async () => {
  // Every step after the timezone was a bare button: a typed «да» reached the model, and the
  // question the user had just answered was asked again.
  const writes = [];
  const settings = {
    setPendingInput: async (_userId, input) => writes.push({ op: "pending", input }),
    setDigestPreset: async (_userId, on) => writes.push({ op: "digests", on }),
    setQuietHours: async (_userId, update) => writes.push({ op: "quiet", update }),
    setWeeklyPreset: async (_userId, on) => writes.push({ op: "weekly", on }),
    completeOnboarding: async () => writes.push({ op: "completed" }),
    get: async () => ({ timezone: "Europe/Kyiv" }),
  };
  const onboarding = new OnboardingService(settings);
  const ctx = callbackContext("onb:digests:on");

  await onboarding.applyTypedStep(ctx, "digests", "да");
  assert.deepEqual(
    writes.map((write) => write.op),
    ["digests", "pending"],
    "the answer is applied and the next step arms its own pending input",
  );
  assert.equal(writes[0].on, true);
  assert.deepEqual(writes[1].input, { kind: "onboarding", step: "quiet" });

  writes.length = 0;
  await onboarding.applyTypedStep(ctx, "quiet", "нет");
  assert.deepEqual(writes[0], { op: "quiet", update: { enabled: false } });

  // Anything that is not an answer re-asks; the model never sees it.
  writes.length = 0;
  ctx.replies.length = 0;
  await onboarding.applyTypedStep(ctx, "weekly", "а что это вообще значит");
  assert.deepEqual(
    writes.map((write) => write.op),
    ["pending"],
  );
  assert.equal(ctx.replies.length, 2, "one line saying yes or no, then the prompt with its buttons again");
  assert.ok(ctx.replies[1].markup, "the re-asked prompt keeps its buttons");

  // The last step clears the pending input: nothing is left to swallow the next message.
  writes.length = 0;
  ctx.replies.length = 0;
  await onboarding.applyTypedStep(ctx, "weekly", "да");
  assert.deepEqual(
    writes.map((write) => write.op),
    ["weekly", "pending", "completed"],
  );
  assert.equal(writes[1].input, null);
  // The settings screen used to close onboarding; with the app off the last word is a sentence.
  assert.equal(ctx.replies.at(-1).markup, null);
});

test("onboarding ends by handing over the app when it is on", async () => {
  const settings = {
    setPendingInput: async () => undefined,
    setWeeklyPreset: async () => undefined,
    completeOnboarding: async () => undefined,
    get: async () => ({ timezone: "Europe/Kyiv" }),
  };
  const ctx = callbackContext("onb:weekly:on", { webAppUrl: APP });
  await new OnboardingService(settings).applyTypedStep(ctx, "weekly", "да");
  assert.deepEqual(webAppUrls(ctx.replies.at(-1).markup), [`${APP}/#/settings`]);
});

test("the week card offers a step for a goal nothing has moved, and the pool is a launch button", () => {
  const buttons = buttonsOf(weeklyBriefingKeyboard([{ id: GOAL_UUID, title: "Запустить группу" }], "ru", APP)).filter(Boolean);
  assert.deepEqual(buttons, [`goal:step:${GOAL_UUID}`]);
  assert.deepEqual(webAppUrls(weeklyBriefingKeyboard([{ id: GOAL_UUID, title: "Запустить группу" }], "ru", APP)), [`${APP}/#/week`]);
  // With nothing idle and the app off the card carries no buttons at all, rather than a dead one.
  assert.deepEqual(buttonsOf(weeklyBriefingKeyboard([], "ru")).filter(Boolean), []);
});
