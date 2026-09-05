import test from "node:test";
import assert from "node:assert/strict";
import { GOAL_IDLE_DAYS, idleDays, idleGoals } from "../../.core-dist/goal-attention.js";

/**
 * Goals had no accountability at all: `review_enabled` was written and never read, so a goal could
 * sit untouched for months and nothing in the product mentioned it. This is the rule that decides
 * which ones the week card raises.
 */

const NOW = new Date("2026-09-27T09:00:00Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * 86_400_000);

test("a goal is raised only after weeks of silence, longest first", () => {
  const rows = [
    { id: "a", title: "Запустить группу", reviewEnabled: true, lastActivityAt: daysAgo(40) },
    { id: "b", title: "Английский", reviewEnabled: true, lastActivityAt: daysAgo(22) },
    { id: "c", title: "Ремонт", reviewEnabled: true, lastActivityAt: daysAgo(3) },
  ];
  assert.deepEqual(
    idleGoals(rows, NOW).map((goal) => [goal.id, goal.idleDays]),
    [
      ["a", 40],
      ["b", 22],
    ],
  );
  assert.equal(idleGoals(rows, NOW).length, 2, "a goal touched three days ago is not silence");
  assert.equal(GOAL_IDLE_DAYS, 21);
});

test("a goal with review turned off is left alone, however long it has been quiet", () => {
  const rows = [{ id: "a", title: "Личное", reviewEnabled: false, lastActivityAt: daysAgo(200) }];
  assert.deepEqual(idleGoals(rows, NOW), []);
});

test("at most three goals are named: more than that is a list, not a nudge", () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    id: `g${index}`,
    title: `Цель ${index}`,
    reviewEnabled: true,
    lastActivityAt: daysAgo(30 + index),
  }));
  assert.deepEqual(
    idleGoals(rows, NOW).map((goal) => goal.id),
    ["g5", "g4", "g3"],
  );
});

test("the exact threshold day counts as silence, and the day before does not", () => {
  const at = (days) => idleGoals([{ id: "a", title: "Цель", reviewEnabled: true, lastActivityAt: daysAgo(days) }], NOW).length;
  assert.equal(at(GOAL_IDLE_DAYS), 1);
  assert.equal(at(GOAL_IDLE_DAYS - 1), 0);
  assert.equal(idleDays(daysAgo(21), NOW), 21);
});
