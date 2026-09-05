import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { TaskCallbacksService } from "../../dist/telegram/handlers/task-callbacks.service.js";
import {
  fuzzyTaskDetailKeyboard,
  goalDetailKeyboard,
  goalListKeyboard,
  goalsScopeKeyboard,
  languageKeyboard,
  quickRescheduleKeyboard,
  quickRescheduleReasonKeyboard,
  remindersKeyboard,
  resultCheckKeyboard,
  screenFooterKeyboard,
  settingsKeyboard,
  startedTaskKeyboard,
  taskDetailKeyboard,
  taskKeyboard,
  taskGroupKeyboard,
  taskListKeyboard,
  taskMoreKeyboard,
  taskScopeKeyboard,
} from "../../dist/telegram/telegram-ui.js";
import { buttonsOf, callbackContext, lastButtons } from "./helpers/telegram-harness.mjs";

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
  /^view:(occ|task):[0-9a-f-]{36}$/,
  /^occ:(start|done|skip|cant|cancel|cancel_one|resched|more|back|check):[0-9a-f-]{36}$/,
  /^resched:(1h|evening|tomorrow|custom):[0-9a-f-]{36}$/,
  /^rr:(h|e|t):(t|d|e|o):[0-9a-f-]{36}$/,
  /^follow:(seen|result):(15m|1h|evening|custom|none):[0-9a-f-]{36}$/,
  /^series:(pause|cancel):[0-9a-f-]{36}$/,
  /^rem:(cancel|mute):[0-9a-f-]{36}$/,
  /^act:(confirm|cancel|undo):[0-9a-f-]{36}$/,
  /^topic:end:[0-9a-f-]{36}$/,
  /^onb:(tz|digests|quiet|weekly):([A-Za-z_/+-]+|on|off|default|other)$/,
  /^tzapply:(all|future|keep)$/,
  /^prefs:(morning|evening|weekly|quiet|snooze):(toggle|morning)$/,
  /^prefs:lang:(open|auto|ru|uk|en)$/,
  /^prefs:tz:open$/,
  /^gl:(active|paused|completed):\d{1,3}$/,
  /^goal:[0-9a-f-]{36}$/,
  /^rem:p:\d{1,3}$/,
  /^account:delete:confirm$/,
  /^ai:(consent|decline)$/,
  /^guide:[a-z_]+$/,
  /^nav:[a-z_]+$/,
  /^history:clear$/,
  /^profile:open$/,
  /^review:weekly:start$/,
  /^tsk:(overdue|today|week|month|all|nodate):\d{1,3}$/,
  /^tdy:\d{1,3}$/,
  /^grp:(t|d):[0-9a-f-]{36}$/,
];

const KEYBOARDS = {
  taskKeyboard: taskKeyboard(OCCURRENCE_ID, "open", "ru", { snooze: true, mute: true }),
  startedTaskKeyboard: startedTaskKeyboard(OCCURRENCE_ID, "uk", { snooze: true, mute: true }),
  taskMoreKeyboard: taskMoreKeyboard(OCCURRENCE_ID, "in_progress", true, TASK_ID, "en"),
  quickRescheduleKeyboard: quickRescheduleKeyboard(OCCURRENCE_ID, "ru"),
  quickRescheduleReasonKeyboard: quickRescheduleReasonKeyboard(OCCURRENCE_ID, "tomorrow", "ru"),
  resultCheckKeyboard: resultCheckKeyboard(OCCURRENCE_ID, "ru"),
  taskDetailKeyboard: taskDetailKeyboard(OCCURRENCE_ID, "open", "ru"),
  fuzzyTaskDetailKeyboard: fuzzyTaskDetailKeyboard("ru"),
  remindersKeyboard: remindersKeyboard([{ deliveryId: OCCURRENCE_ID, title: "Позвонить", when: "сегодня 10:00" }], "ru"),
  screenFooterKeyboard: screenFooterKeyboard("ru"),
  settingsKeyboard: settingsKeyboard("ru", { morningDigestEnabled: true, eveningDigestEnabled: false, weeklyReviewEnabled: true, quietHoursEnabled: true }),
  taskListKeyboard: taskListKeyboard([SINGLE_GROUP, FUZZY_GROUP, MULTI_GROUP], "ru", {
    source: "tasks",
    page: 0,
    pages: 3,
    rest: 9,
    pageCallback: (page) => `tsk:week:${page}`,
  }),
  todayListKeyboard: taskListKeyboard([MULTI_GROUP], "ru", { source: "today", page: 1, pages: 2, rest: 0, pageCallback: (page) => `tdy:${page}` }),
  taskScopeKeyboard: taskScopeKeyboard("week", { overdue: 3, today: 4, week: 9, month: 12, all: 20, nodate: 2 }, "ru"),
  taskGroupKeyboard: taskGroupKeyboard(MULTI_GROUP, "tasks", "ru"),
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
  const tasks = {
    getOccurrenceContext: async () => overrides.context ?? null,
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
  const settings = { get: async () => ({ version: 1, morningReferenceTime: "09:00" }), setPendingInput: async () => undefined };
  const screens = {
    showOccurrence: async () => Boolean(overrides.context),
    showFuzzyTask: async () => Boolean(overrides.context),
    taskCard: async () => "карточка",
    occurrenceKeyboard: () => new InlineKeyboard().text("ok", `occ:done:${OCCURRENCE_ID}`),
  };
  return { service: new TaskCallbacksService(tasks, {}, settings, actions, {}, screens), applied };
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

test("a card whose text Telegram refuses to edit still loses its buttons", async () => {
  const { service: handler } = service({ context });
  const ctx = callbackContext(`occ:done:${OCCURRENCE_ID}`, { editFails: true });
  await handler.occurrence(ctx);
  assert.match(ctx.answers[0], /\S/);
});
