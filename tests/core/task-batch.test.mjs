import test from "node:test";
import assert from "node:assert/strict";
import { actionDisposition } from "../../.core-dist/ai-actions.js";
import { compileTaskBatchShape } from "../../.core-dist/task-batch.js";

const create = (stepId, source = "user_explicit") => ({
  operation: "create", stepId, source, confidence: 1, criticalExplicit: false, habitModeExplicit: false,
  title: stepId, why: null, nextAction: null, context: null, checklist: null, goalLink: null,
  definition: { kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv", plannedStartAt: "2026-09-01T06:00:00Z", plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null, fuzzyHorizonText: null, reviewAt: null, recurrenceRule: null, recurrenceTimezone: null, missPolicy: null, habitMode: false, minimumAction: null, desiredAction: null, habitTrigger: null },
});

test("task batch accepts backward temporary references and emits summaries", () => {
  const batch = { type: "task_batch", source: "user_explicit", confidence: 1, steps: [
    create("a"),
    { operation: "link_goal", stepId: "b", source: "user_explicit", confidence: 1, target: { kind: "created", stepId: "a" }, goalId: "00000000-0000-4000-8000-000000000001", expectedGoalVersion: 1 },
  ] };
  assert.deepEqual(compileTaskBatchShape(batch).summaries, ["Создать «a»", "Связать задачу с целью"]);
  assert.equal(actionDisposition(batch), "apply");
});

test("task batch rejects duplicate IDs and forward temporary references", () => {
  assert.throws(() => compileTaskBatchShape({ type: "task_batch", source: "user_explicit", confidence: 1, steps: [create("a"), create("a")] }), /unique/);
  assert.throws(() => compileTaskBatchShape({ type: "task_batch", source: "user_explicit", confidence: 1, steps: [
    { operation: "link_goal", stepId: "b", source: "user_explicit", confidence: 1, target: { kind: "created", stepId: "a" }, goalId: "00000000-0000-4000-8000-000000000001", expectedGoalVersion: 1 },
    create("a"),
  ] }), /earlier create/);
});

test("one inferred or risky step makes the whole batch confirmable", () => {
  assert.equal(actionDisposition({ type: "task_batch", source: "user_explicit", confidence: 1, steps: [create("a"), create("b", "ai_inferred")] }), "confirm");
});
