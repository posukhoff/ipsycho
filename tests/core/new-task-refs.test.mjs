import test from "node:test";
import assert from "node:assert/strict";
import { foldNewTaskRefs, isNewTaskRef } from "../../.core-dist/new-task-refs.js";

const create = (title, extra = {}) => ({
  type: "create_task",
  intent: "explicit",
  title,
  why: null,
  nextAction: null,
  context: null,
  checklist: null,
  importance: "normal",
  kind: "task",
  when: { mode: "date", date: "2026-09-05" },
  recurrence: null,
  reminder: null,
  timezone: null,
  goal: null,
  ...extra,
});

test("a goal link and a reminder addressed to n1 fold into the create_task itself", () => {
  const reminder = { kind: "offset", anchor: "start", minutes: -30, quiet: "respect" };
  const folded = foldNewTaskRefs([
    create("Попросить обратную связь"),
    { type: "goal", intent: "explicit", op: "link", goal: { id: "g1" }, task: { id: "n1" }, title: null, why: null, targetDate: null, status: null },
    { type: "set_reminder", intent: "explicit", task: { id: "n1" }, mode: "add", reminder },
    { type: "set_task_state", intent: "explicit", task: { id: "t3" }, state: "done", note: null, scope: null },
  ]);
  assert.deepEqual(folded.issues, []);
  assert.equal(folded.actions.length, 2);
  assert.equal(folded.actions[0].type, "create_task");
  assert.deepEqual(folded.actions[0].goal, { id: "g1" });
  assert.deepEqual(folded.actions[0].reminder, reminder);
  assert.equal(folded.actions[1].type, "set_task_state");
  assert.deepEqual(folded.originalIndex, [0, 3]);
});

test("n2 names the second create_task; an update and a reschedule rewrite its fields", () => {
  const folded = foldNewTaskRefs([
    create("Первая"),
    create("Вторая"),
    {
      type: "update_task",
      intent: "explicit",
      task: { id: "n2" },
      patch: { title: null, why: "потому что", nextAction: null, context: null, checklist: null, importance: "critical" },
    },
    {
      type: "reschedule",
      intent: "explicit",
      task: { id: "n2" },
      when: { mode: "exact", date: "2026-09-06", time: "10:00", durationMinutes: null },
      reason: null,
      scope: null,
      recurrence: null,
      timezone: null,
    },
  ]);
  assert.deepEqual(folded.issues, []);
  assert.equal(folded.actions.length, 2);
  assert.equal(folded.actions[0].title, "Первая");
  assert.equal(folded.actions[1].why, "потому что");
  assert.equal(folded.actions[1].importance, "critical");
  assert.equal(folded.actions[1].when.time, "10:00");
});

test("a state change on a task that does not exist yet, or an n beyond the creates, is an issue", () => {
  const folded = foldNewTaskRefs([
    create("Одна"),
    { type: "set_task_state", intent: "explicit", task: { id: "n1" }, state: "done", note: null, scope: null },
    { type: "set_reminder", intent: "explicit", task: { id: "n5" }, mode: "clear", reminder: null },
  ]);
  assert.deepEqual(
    folded.issues.map((issue) => [issue.index, issue.code]),
    [
      [1, "new_task_state"],
      [2, "ref_not_found"],
    ],
  );
  assert.equal(folded.actions.length, 1);
  assert.equal(isNewTaskRef("n1"), true);
  assert.equal(isNewTaskRef("t1"), false);
});
