import test from "node:test";
import assert from "node:assert/strict";
import { validateGoalFocusTurn } from "../../dist/chat/chat.service.js";
import { buildSystemPrompt } from "../../dist/ai/ai.service.js";

const goalId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const selected = { goals: [{ goalId, goalVersion: 3 }], goalResolution: { requested: true, state: "selected", selected: { goalId, goalVersion: 3 }, candidates: [{ goalId }] } };

test("persisted goal advice requires the exact owned focus and version", () => {
  assert.match(validateGoalFocusTurn({ goalAnalysisFocus: null, question: null, actions: [] }, selected), /requires goalAnalysisFocus/);
  assert.match(validateGoalFocusTurn({ goalAnalysisFocus: { goalId: otherId, expectedVersion: 1 }, question: null, actions: [] }, selected), /outside the current workspace/);
  assert.equal(validateGoalFocusTurn({ goalAnalysisFocus: { goalId, expectedVersion: 3 }, question: null, actions: [] }, selected), null);
});

test("ambiguous goal advice asks one question and performs no mutation", () => {
  const ambiguous = { goals: [{ goalId, goalVersion: 3 }, { goalId: otherId, goalVersion: 1 }], goalResolution: { requested: true, state: "ambiguous", candidates: [{ goalId }, { goalId: otherId }] } };
  assert.equal(validateGoalFocusTurn({ goalAnalysisFocus: null, question: "Какую из двух целей ты имеешь в виду?", actions: [] }, ambiguous), null);
  assert.match(validateGoalFocusTurn({ goalAnalysisFocus: null, question: null, actions: [{}] }, ambiguous), /perform no action/);
});

test("goal-advice prompt distinguishes evidence, proposals, capacity and causal hypotheses", () => {
  const prompt = buildSystemPrompt("Europe/Kyiv", new Date("2026-08-22T12:00:00Z"));
  assert.match(prompt, /linkedTasks/);
  assert.match(prompt, /persisted facts, assumptions, and proposals/);
  assert.match(prompt, /at most three priorities/);
  assert.match(prompt, /hypotheses with a bounded test/);
});
