import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WeekCallbacksService } from "../../dist/telegram/handlers/week-callbacks.service.js";
import { buttonsOf, callbackContext, lastButtons } from "./helpers/telegram-harness.mjs";

const TASK_ID = randomUUID();
const SECOND_TASK_ID = randomUUID();

function service(overrides = {}) {
  const toggled = [];
  const applied = [];
  const redrawn = [];
  const tasks = {
    togglePickedForWeek: async (_workspaceId, taskId, today) => {
      toggled.push({ taskId, today });
      // `??` would swallow the null that means "no longer in the pool".
      return "toggleResult" in overrides ? overrides.toggleResult : "picked";
    },
    getTask: async () => overrides.task ?? { id: TASK_ID, version: 3, title: "Разобраться с налогами", status: "active", timeMode: "fuzzy", timezone: "Europe/Kyiv" },
    listPickedForWeek: async () => overrides.remaining ?? [{ id: SECOND_TASK_ID, title: "Привести в порядок машину" }],
  };
  const actions = {
    applyResolved: async (resolved) => {
      applied.push(resolved);
      if (overrides.applyThrows) throw overrides.applyThrows;
      return { groupId: randomUUID(), items: [], undoable: true };
    },
  };
  const settings = { get: async () => ({ morningReferenceTime: "09:00" }) };
  const screens = { weekPlan_: async (_ctx, edit, page) => void redrawn.push({ edit, page }) };
  return { service: new WeekCallbacksService(tasks, actions, settings, screens), toggled, applied, redrawn };
}

test("a tap takes a pool task for the week and redraws the screen it came from", async () => {
  const { service: handler, toggled, redrawn } = service();
  const ctx = callbackContext(`wk:t:0:${TASK_ID}`);
  await handler.toggle(ctx);
  assert.equal(toggled.length, 1);
  assert.equal(toggled[0].taskId, TASK_ID);
  assert.match(toggled[0].today, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(ctx.answers[0], /\S/);
  assert.deepEqual(redrawn, [{ edit: true, page: 0 }], "the tap redraws the page it came from");
});

test("the same tap releases the task, so the pick needs no Undo of its own", async () => {
  const { service: handler, redrawn } = service({ toggleResult: "released" });
  const ctx = callbackContext(`wk:t:0:${TASK_ID}`);
  await handler.toggle(ctx);
  assert.match(ctx.answers[0], /\S/);
  assert.equal(redrawn.length, 1);
});

test("a toggle on a later page redraws that page, not the first", async () => {
  const { service: handler, redrawn } = service();
  await handler.toggle(callbackContext(`wk:t:2:${TASK_ID}`));
  assert.deepEqual(redrawn, [{ edit: true, page: 2 }]);
});

test("a full week and a task that left the pool are answered, not written", async () => {
  const full = service({ toggleResult: "full" });
  const fullCtx = callbackContext(`wk:t:0:${TASK_ID}`);
  await full.service.toggle(fullCtx);
  assert.match(fullCtx.answers[0], /7/, "the toast says how many the week already holds");
  assert.equal(full.redrawn.length, 0, "a refused pick does not redraw");

  const gone = service({ toggleResult: null });
  const goneCtx = callbackContext(`wk:t:0:${TASK_ID}`);
  await gone.service.toggle(goneCtx);
  assert.match(goneCtx.answers[0], /\S/);
  assert.equal(gone.redrawn.length, 0);

  const malformed = service();
  const badCtx = callbackContext("wk:t:0:not-a-uuid");
  await malformed.service.toggle(badCtx);
  assert.equal(malformed.toggled.length, 0);
});

test("the morning tap gives the task today as its day and drops the row it acted on", async () => {
  const { service: handler, applied } = service();
  const ctx = callbackContext(`wk:d:${TASK_ID}`);
  await handler.takeToday(ctx);
  assert.equal(applied.length, 1);
  const [action] = applied[0];
  assert.equal(action.type, "reschedule");
  assert.equal(action.intent, "explicit");
  assert.deepEqual(action.target, { kind: "task", taskId: TASK_ID, taskVersion: 3 });
  assert.equal(action.when.mode, "date");
  assert.match(action.when.date, /^\d{4}-\d{2}-\d{2}$/);
  // The card keeps the other picked task and loses the one just taken.
  assert.deepEqual(lastButtons(ctx), [`wk:d:${SECOND_TASK_ID}`, "nav:today"]);
});

test("a task already out of the pool is not taken into today twice", async () => {
  const { service: handler, applied } = service({ task: { id: TASK_ID, version: 4, title: "Налоги", status: "active", timeMode: "window", timezone: "Europe/Kyiv" } });
  const ctx = callbackContext(`wk:d:${TASK_ID}`);
  await handler.takeToday(ctx);
  assert.equal(applied.length, 0);
  assert.match(ctx.answers[0], /\S/);
  assert.deepEqual(buttonsOf(ctx.markups[0] ?? null), []);
});

test("a failure to take it into today says so and leaves the card alone", async () => {
  const { service: handler } = service({ applyThrows: new Error("target task is missing or stale") });
  const ctx = callbackContext(`wk:d:${TASK_ID}`);
  await handler.takeToday(ctx);
  assert.match(ctx.answers[0], /\S/);
  assert.equal(ctx.markups.length, 0);
});

test("paging redraws the requested page without writing", async () => {
  const { service: handler, toggled, redrawn } = service();
  const ctx = callbackContext("wk:p:2");
  await handler.page(ctx);
  assert.equal(toggled.length, 0);
  assert.deepEqual(redrawn, [{ edit: true, page: 2 }]);
});
