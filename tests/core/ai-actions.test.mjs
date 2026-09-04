import test from "node:test";
import assert from "node:assert/strict";
import { disposition, groupDisposition, isUndoable } from "../../.core-dist/ai-actions.js";

const base = { timezone: "Europe/Kyiv", reviewTime: "09:00" };
const body = {
  title: "Позвонить клиенту",
  why: null,
  nextAction: null,
  context: null,
  checklist: null,
  importance: "normal",
  kind: "task",
  when: { mode: "exact", date: "2026-09-10", time: "10:30", durationMinutes: null },
  recurrence: null,
  reminder: null,
  habit: null,
  timezone: null,
};
const target = {
  kind: "occurrence",
  taskId: "11111111-1111-4111-8111-111111111111",
  taskVersion: 1,
  occurrenceId: "22222222-2222-4222-8222-222222222222",
  occurrenceVersion: 1,
  timezone: "Europe/Kyiv",
};
const explicit = (action) => ({ ...base, intent: "explicit", ...action });
const inferred = (action) => ({ ...base, intent: "inferred", ...action });

test("explicit reversible actions apply immediately, inferred ones wait for confirmation", () => {
  const rows = [
    { type: "create_task", body, goal: null },
    {
      type: "update_task",
      taskId: target.taskId,
      taskVersion: 1,
      patch: { title: "Новое", why: null, nextAction: null, context: null, checklist: null, importance: null, habit: null },
    },
    { type: "set_task_state", target, state: "done", note: null },
    { type: "set_task_state", target, state: "started", note: null },
    { type: "set_task_state", target, state: "seen", note: "нет доступа к CRM" },
    { type: "reschedule", target, when: body.when, recurrence: null, reason: null },
    { type: "set_reminder", target, mode: "replace", reminder: { kind: "offset", anchor: "start", minutes: -30, quiet: "respect" } },
    { type: "set_reminder", target, mode: "clear", reminder: null },
    {
      type: "goal",
      op: "create",
      goalId: null,
      goalVersion: null,
      taskId: null,
      taskVersion: null,
      title: "Запустить курс",
      why: null,
      targetDate: null,
      status: null,
      reviewEnabled: null,
    },
    {
      type: "goal",
      op: "link",
      goalId: "33333333-3333-4333-8333-333333333333",
      goalVersion: 1,
      taskId: target.taskId,
      taskVersion: 1,
      title: null,
      why: null,
      targetDate: null,
      status: null,
      reviewEnabled: null,
    },
    { type: "plan", goal: { title: "Цель", why: null, targetDate: null }, tasks: [body] },
    { type: "memory", op: "save", memoryId: null, memoryVersion: null, kind: "preference", content: "Сначала факты, потом звонок", sensitive: false },
    {
      type: "settings",
      operation: "language",
      expectedVersion: 3,
      timezone: null,
      applyTimezoneTo: null,
      language: "ru",
      digestKind: null,
      enabled: null,
      time: null,
      weekday: null,
      weekdayStart: null,
      weekdayEnd: null,
      weekendStart: null,
      weekendEnd: null,
      snoozeUntilDate: null,
      snoozeUntilTime: null,
      eventOffsets: null,
      plannedTaskOffsetMinutes: null,
      criticalPostDueMinutes: null,
      seenNormalMinutes: null,
      seenRequiredMinutes: null,
      seenCriticalMinutes: null,
    },
  ];
  for (const row of rows) {
    assert.equal(disposition(explicit(row)), "apply", `${row.type} explicit`);
    assert.equal(disposition(inferred(row)), "confirm", `${row.type} inferred`);
  }
});

test("destructive, critical, habit, sensitive and quiet-hours-bypass actions always confirm", () => {
  const rows = [
    { type: "create_task", body: { ...body, importance: "critical" }, goal: null },
    { type: "create_task", body: { ...body, habit: { minimumAction: "открыть план", desiredAction: "три приоритета", trigger: null } }, goal: null },
    { type: "create_task", body: { ...body, reminder: { kind: "offset", anchor: "start", minutes: 0, quiet: "bypass" } }, goal: null },
    { type: "plan", goal: { title: "Цель", why: null, targetDate: null }, tasks: [body, { ...body, importance: "critical" }] },
    {
      type: "update_task",
      taskId: target.taskId,
      taskVersion: 1,
      patch: { title: null, why: null, nextAction: null, context: null, checklist: null, importance: "critical", habit: null },
    },
    {
      type: "update_task",
      taskId: target.taskId,
      taskVersion: 1,
      patch: { title: null, why: null, nextAction: null, context: null, checklist: null, importance: null, habit: { minimumAction: "a", desiredAction: "b", trigger: null } },
    },
    { type: "set_task_state", target, state: "cancelled", note: null },
    { type: "set_task_state", target, state: "skipped", note: null },
    { type: "set_reminder", target, mode: "add", reminder: { kind: "at", date: "2026-09-10", time: "23:30", quiet: "bypass" } },
    {
      type: "goal",
      op: "update",
      goalId: "33333333-3333-4333-8333-333333333333",
      goalVersion: 1,
      taskId: null,
      taskVersion: null,
      title: null,
      why: null,
      targetDate: null,
      status: "cancelled",
      reviewEnabled: null,
    },
    { type: "memory", op: "save", memoryId: null, memoryVersion: null, kind: "context", content: "диагноз", sensitive: true },
    { type: "memory", op: "update", memoryId: "44444444-4444-4444-8444-444444444444", memoryVersion: 1, kind: null, content: "новое", sensitive: null },
    { type: "memory", op: "delete", memoryId: "44444444-4444-4444-8444-444444444444", memoryVersion: 1, kind: null, content: null, sensitive: null },
  ];
  for (const row of rows) assert.equal(disposition(explicit(row)), "confirm", `${row.type} ${row.op ?? row.state ?? ""}`);
});

test("disabling habit mode is an ordinary explicit edit", () => {
  const action = explicit({
    type: "update_task",
    taskId: target.taskId,
    taskVersion: 1,
    patch: { title: null, why: null, nextAction: null, context: null, checklist: null, importance: null, habit: { enabled: false } },
  });
  assert.equal(disposition(action), "apply");
});

test("one message is one package: any confirm-level action holds the whole group", () => {
  const create = explicit({ type: "create_task", body, goal: null });
  const cancel = explicit({ type: "set_task_state", target, state: "cancelled", note: null });
  assert.equal(groupDisposition([create, create]), "apply");
  assert.equal(groupDisposition([create, cancel]), "confirm");
  assert.equal(groupDisposition([]), "apply");
});

test("a group of only seen marks is not offered for undo", () => {
  const seen = explicit({ type: "set_task_state", target, state: "seen", note: null });
  const done = explicit({ type: "set_task_state", target, state: "done", note: null });
  assert.equal(isUndoable([seen]), false);
  assert.equal(isUndoable([seen, done]), true);
});
