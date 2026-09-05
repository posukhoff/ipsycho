import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { TaskCallbacksService } from "../../dist/telegram/handlers/task-callbacks.service.js";
import { OnboardingService } from "../../dist/telegram/handlers/onboarding.service.js";
import {
  fuzzyTaskDetailKeyboard,
  goalDetailKeyboard,
  goalListKeyboard,
  goalsScopeKeyboard,
  languageKeyboard,
  pausedSeriesKeyboard,
  weekPlanKeyboard,
  weeklyBriefingKeyboard,
  quickRescheduleKeyboard,
  quickRescheduleReasonKeyboard,
  remindersKeyboard,
  screenFooterKeyboard,
  settingsKeyboard,
  taskDetailKeyboard,
  taskKeyboard,
  taskGroupKeyboard,
  taskListKeyboard,
  taskMoreKeyboard,
  taskScopeKeyboard,
} from "../../dist/telegram/telegram-ui.js";
import { buttonsOf, callbackContext, lastButtons, lastReplyButtons } from "./helpers/telegram-harness.mjs";

const OCCURRENCE_ID = randomUUID();
const SECOND_OCCURRENCE_ID = randomUUID();
const TASK_ID = randomUUID();
const GROUP_ID = randomUUID();
const GOAL_UUID = randomUUID();

const listRow = (title, occurrenceId) => ({
  task: { id: TASK_ID, title, importance: "normal", timezone: "Europe/Kyiv" },
  occurrence: occurrenceId ? { id: occurrenceId, status: "open", timezone: "Europe/Kyiv", plannedStartAt: new Date("2026-09-06T09:00:00Z") } : null,
});
const groupOf = (rows, extra = {}) => ({
  key: rows[0].occurrence?.id ?? rows[0].task.id,
  title: rows[0].task.title,
  importance: "normal",
  recurrenceRule: null,
  rows,
  lead: rows[0],
  pastCount: 0,
  ...extra,
});
const SINGLE_GROUP = groupOf([listRow("Позвонить клиенту очень длинным заголовком, который придётся обрезать", OCCURRENCE_ID)]);
const FUZZY_GROUP = groupOf([listRow("Задача без occurrence", null)]);
const MULTI_GROUP = groupOf([listRow("Позвонить маме", OCCURRENCE_ID), listRow("Позвонить маме", SECOND_OCCURRENCE_ID)], { recurrenceRule: "FREQ=DAILY" });

// Every pattern the bot registers. A generated payload that matches none of them is a dead button.
const ROUTES = [
  /^view:(occ|task):[0-9a-f-]{36}(?::(overdue|today|week|month|all|nodate))?$/,
  /^occ:(done|skip|cancel|cancel_one|resched|more|back):[0-9a-f-]{36}$/,
  /^resched:(1h|evening|tomorrow|custom):[0-9a-f-]{36}$/,
  /^rr:(h|e|t):(t|d|e|o):[0-9a-f-]{36}$/,
  /^follow:snooze:(15m|1h):[0-9a-f-]{36}$/,
  /^series:(pause|resume|cancel):[0-9a-f-]{36}$/,
  /^rem:(cancel|mute):[0-9a-f-]{36}$/,
  /^act:(confirm|cancel|undo):[0-9a-f-]{36}$/,
  /^onb:(tz|digests|quiet|weekly):([A-Za-z_/+-]+|on|off|default|other)$/,
  /^tzapply:(digests|quiet|both|keep)$/,
  /^prefs:(morning|weekly|quiet|snooze):(toggle|morning)$/,
  /^prefs:lang:(open|auto|ru|uk|en)$/,
  /^prefs:tz:open$/,
  /^gl:(active|paused|completed):\d{1,3}$/,
  /^goal:[0-9a-f-]{36}$/,
  /^goal:step:[0-9a-f-]{36}$/,
  /^rem:p:\d{1,3}$/,
  /^account:delete_confirm$/,
  /^ai:(consent|decline)$/,
  /^guide:[a-z_]+$/,
  /^nav:[a-z_]+$/,
  /^history:clear$/,
  /^profile:open$/,
  /^tsk:(overdue|today|week|month|all|nodate):\d{1,3}$/,
  /^tdy:\d{1,3}$/,
  /^paused:\d{1,3}$/,
  /^wk:t:\d{1,3}:[0-9a-f-]{36}$/,
  /^wk:d:[0-9a-f-]{36}$/,
  /^wk:p:\d{1,3}$/,
  /^grp:(t|d):[0-9a-f-]{36}(?::(overdue|today|week|month|all|nodate))?$/,
];

const KEYBOARDS = {
  taskKeyboard: taskKeyboard(OCCURRENCE_ID, "ru", { snooze: true, mute: true }),
  taskMoreKeyboard: taskMoreKeyboard(OCCURRENCE_ID, true, TASK_ID, "en", true),
  quickRescheduleKeyboard: quickRescheduleKeyboard(OCCURRENCE_ID, "ru"),
  quickRescheduleReasonKeyboard: quickRescheduleReasonKeyboard(OCCURRENCE_ID, "tomorrow", "ru"),
  taskDetailKeyboard: taskDetailKeyboard(OCCURRENCE_ID, "ru"),
  fuzzyTaskDetailKeyboard: fuzzyTaskDetailKeyboard("ru"),
  remindersKeyboard: remindersKeyboard([{ deliveryId: OCCURRENCE_ID, title: "Позвонить", when: "сегодня 10:00" }], "ru"),
  screenFooterKeyboard: screenFooterKeyboard("ru"),
  settingsKeyboard: settingsKeyboard("ru", { morningDigestEnabled: true, eveningDigestEnabled: false, weeklyReviewEnabled: true, quietHoursEnabled: true }),
  taskListKeyboard: taskListKeyboard([SINGLE_GROUP, FUZZY_GROUP, MULTI_GROUP], "ru", {
    source: "tasks",
    scope: "overdue",
    page: 0,
    pages: 3,
    rest: 9,
    pageCallback: (page) => `tsk:week:${page}`,
  }),
  todayListKeyboard: taskListKeyboard([MULTI_GROUP], "ru", { source: "today", page: 1, pages: 2, rest: 0, pageCallback: (page) => `tdy:${page}` }),
  taskScopeKeyboard: taskScopeKeyboard("week", { overdue: 3, today: 4, week: 9, month: 12, all: 20, nodate: 2 }, "ru", 2),
  pausedSeriesKeyboard: pausedSeriesKeyboard([{ id: TASK_ID, title: "Зарядка по будням", recurrence: "FREQ=WEEKLY" }], "ru", { page: 1, pages: 3, rest: 4 }),
  weeklyBriefingKeyboard: weeklyBriefingKeyboard([{ id: GOAL_UUID, title: "Запустить первую платную группу с очень длинным названием" }], "ru"),
  weekPlanKeyboard: weekPlanKeyboard([{ id: TASK_ID, title: "Разобраться с налогами", picked: true }], "ru", { page: 1, pages: 3, rest: 5 }),
  taskGroupKeyboard: taskGroupKeyboard(MULTI_GROUP, "tasks", "ru", "overdue"),
  goalsScopeKeyboard: goalsScopeKeyboard("active", "ru"),
  goalListKeyboard: goalListKeyboard([{ id: GOAL_UUID, title: "Запустить первую платную группу" }], "ru", { page: 0, pages: 2, rest: 4, scope: "paused" }),
  goalDetailKeyboard: goalDetailKeyboard([{ id: TASK_ID, title: "Позвонить клиенту" }], "ru"),
  languageKeyboard: languageKeyboard("ru"),
  remindersPagedKeyboard: remindersKeyboard([{ deliveryId: OCCURRENCE_ID, title: "Позвонить", when: "сегодня 10:00" }], "ru", { page: 1, pages: 3, rest: 8 }),
};

test("every generated callback payload fits Telegram's 64-byte limit and is routed by a registered handler", () => {
  for (const [name, keyboard] of Object.entries(KEYBOARDS)) {
    const payloads = buttonsOf(keyboard);
    assert.ok(payloads.length, `${name} produced no buttons`);
    for (const payload of payloads) {
      assert.ok(Buffer.byteLength(payload, "utf8") <= 64, `${name}: ${payload} is ${Buffer.byteLength(payload, "utf8")} bytes`);
      assert.ok(
        ROUTES.some((route) => route.test(payload)),
        `${name}: ${payload} matches no registered handler`,
      );
    }
  }
});

function service(overrides = {}) {
  const applied = [];
  const seriesOperations = [];
  const rerendered = [];
  const tasks = {
    getOccurrenceContext: async () => overrides.context ?? null,
    getTask: async () => overrides.seriesTask ?? null,
    recordInteraction: async () => undefined,
    getTaskCardExtras: async () => ({ checklist: [], goalTitle: null }),
    ...overrides.tasks,
  };
  const actions = {
    validateResolved: async () => overrides.issues ?? [],
    applySeriesOperation: async (_scope, taskId, expectedVersion, operation) => {
      seriesOperations.push({ taskId, expectedVersion, operation });
      if (overrides.applyThrows) throw overrides.applyThrows;
      return { applied: { groupId: GROUP_ID, count: 1, titles: [], items: [] } };
    },
    applyResolved: async (resolved) => {
      applied.push(resolved);
      if (overrides.applyThrows) throw overrides.applyThrows;
      return { groupId: GROUP_ID, items: [], undoable: true };
    },
    ...overrides.actions,
  };
  const settings = { get: async () => ({ version: 1, morningReferenceTime: "09:00" }), setPendingInput: async () => undefined };
  const screens = {
    showOccurrence: async () => Boolean(overrides.context),
    showFuzzyTask: async () => Boolean(overrides.context),
    taskCard: async () => "карточка",
    occurrenceKeyboard: () => new InlineKeyboard().text("ok", `occ:done:${OCCURRENCE_ID}`),
    pausedSeries_: async () => void rerendered.push(true),
  };
  return { service: new TaskCallbacksService(tasks, {}, settings, actions, screens), applied, seriesOperations, rerendered };
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

test("More and Back only swap the keyboard, they never write", async () => {
  const { service: handler, applied } = service({ context });
  const more = callbackContext(`occ:more:${OCCURRENCE_ID}`);
  await handler.occurrence(more);
  assert.equal(applied.length, 0);
  assert.ok(lastButtons(more).includes(`occ:cancel:${OCCURRENCE_ID}`));
  const back = callbackContext(`occ:back:${OCCURRENCE_ID}`);
  await handler.occurrence(back);
  assert.equal(applied.length, 0);
  assert.ok(lastButtons(back).includes(`occ:done:${OCCURRENCE_ID}`));
});

test("pause is offered for an endless series and withheld from one that already ends", () => {
  const payloads = (keyboard) => keyboard.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(payloads(taskMoreKeyboard(OCCURRENCE_ID, true, TASK_ID, "ru", true)).includes(`series:pause:${TASK_ID}`));
  // A series with an end date has nothing to gain from a pause: it would only lose its dates.
  assert.ok(!payloads(taskMoreKeyboard(OCCURRENCE_ID, true, TASK_ID, "ru", false)).includes(`series:pause:${TASK_ID}`));
});

test("resuming a series redraws the paused list and offers no Undo, because undo cannot take the dates back", async () => {
  const seriesTask = { id: TASK_ID, version: 4, title: "Зарядка", status: "paused", recurrenceRule: "FREQ=DAILY" };
  const { service: handler, seriesOperations, rerendered } = service({ seriesTask });
  const ctx = callbackContext(`series:resume:${TASK_ID}`);
  await handler.series(ctx);
  assert.deepEqual(seriesOperations, [{ taskId: TASK_ID, expectedVersion: 4, operation: "resume" }]);
  assert.equal(rerendered.length, 1, "the list still showing the series as paused must be redrawn");
  assert.deepEqual(lastReplyButtons(ctx), [], "undo of resume would leave a paused series with live dates");
  assert.match(ctx.answers[0], /\S/);
});

test("pausing a series keeps its Undo, which does restore what it changed", async () => {
  const seriesTask = { id: TASK_ID, version: 2, title: "Зарядка", status: "active", recurrenceRule: "FREQ=DAILY" };
  const { service: handler, seriesOperations } = service({ seriesTask });
  const ctx = callbackContext(`series:pause:${TASK_ID}`);
  await handler.series(ctx);
  assert.deepEqual(seriesOperations, [{ taskId: TASK_ID, expectedVersion: 2, operation: "pause" }]);
  assert.deepEqual(lastReplyButtons(ctx), [`act:undo:${GROUP_ID}`]);
});

test("a series button for a task that is gone reports it instead of acting", async () => {
  const { service: handler, seriesOperations } = service({});
  const ctx = callbackContext(`series:resume:${TASK_ID}`);
  await handler.series(ctx);
  assert.deepEqual(seriesOperations, []);
  assert.match(ctx.answers[0], /\S/);
});

test("a card whose text Telegram refuses to edit still loses its buttons", async () => {
  const { service: handler } = service({ context });
  const ctx = callbackContext(`occ:done:${OCCURRENCE_ID}`, { editFails: true });
  await handler.occurrence(ctx);
  assert.match(ctx.answers[0], /\S/);
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
  const onboarding = new OnboardingService(settings, { settings_: async () => writes.push({ op: "settings_screen" }) });
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
  await onboarding.applyTypedStep(ctx, "weekly", "да");
  assert.deepEqual(
    writes.map((write) => write.op),
    ["weekly", "pending", "completed", "settings_screen"],
  );
  assert.equal(writes[1].input, null);
});

test("a card opened from a filtered list goes back to that filter, not to the default one", () => {
  // Two back buttons pointed at a fixed screen: opening a task from «⚠️ Просрочено» and returning
  // dropped the user into the week window, and the filter they had chosen was gone.
  const fromOverdue = buttonsOf(taskListKeyboard([SINGLE_GROUP], "ru", { source: "tasks", scope: "overdue" }));
  assert.ok(fromOverdue.includes(`view:occ:${OCCURRENCE_ID}:overdue`), fromOverdue.join(" | "));
  assert.ok(buttonsOf(taskDetailKeyboard(OCCURRENCE_ID, "ru", "overdue")).includes("tsk:overdue:0"));
  assert.ok(buttonsOf(taskGroupKeyboard(MULTI_GROUP, "tasks", "ru", "nodate")).includes("tsk:nodate:0"));

  // Without a filter nothing changes: the list button still leads to the task screen.
  assert.ok(buttonsOf(taskDetailKeyboard(OCCURRENCE_ID, "ru")).includes("nav:tasks"));
  assert.ok(buttonsOf(taskListKeyboard([SINGLE_GROUP], "ru", { source: "tasks" })).includes(`view:occ:${OCCURRENCE_ID}`));
});

test("the week card offers a step for a goal nothing has moved", () => {
  const buttons = buttonsOf(weeklyBriefingKeyboard([{ id: GOAL_UUID, title: "Запустить группу" }], "ru"));
  assert.deepEqual(buttons, [`goal:step:${GOAL_UUID}`, "nav:week"]);
  // With nothing idle the card keeps only the way to the pool.
  assert.deepEqual(buttonsOf(weeklyBriefingKeyboard([], "ru")), ["nav:week"]);
});
