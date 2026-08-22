import test from "node:test";
import assert from "node:assert/strict";
import { resolveGoalFocus } from "../../.core-dist/goal-focus.js";

const goals = [
  { goalId: "a", goalVersion: 2, title: "Найти новую работу", status: "active" },
  { goalId: "b", goalVersion: 1, title: "Запустить консультации", status: "active" },
];

test("goal focus selects one exact owned title", () => assert.equal(resolveGoalFocus("Проанализируй цель Найти новую работу", goals).selected?.goalId, "a"));
test("generic goal reference remains ambiguous with several plausible goals", () => assert.equal(resolveGoalFocus("Проанализируй мою цель", goals, ["Запустить консультации"]).state, "ambiguous"));
test("non-goal advice does not force a focus", () => assert.equal(resolveGoalFocus("Как лучше провести встречу?", goals).state, "none"));
