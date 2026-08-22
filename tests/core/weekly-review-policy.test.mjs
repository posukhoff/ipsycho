import test from "node:test";
import assert from "node:assert/strict";
import { aggregateHistoricalGoalMovement, habitCompletionStats, isWeeklyMovementEvent, isWeeklyReviewGoalStatus } from "../../.core-dist/weekly-review-policy.js";

test("weekly movement ignores creation and blocker-only noise", () => {
  assert.equal(isWeeklyMovementEvent("task:created"), false);
  assert.equal(isWeeklyMovementEvent("occurrence:cant_start"), false);
  assert.equal(isWeeklyMovementEvent("occurrence:done"), true);
  assert.equal(isWeeklyMovementEvent("occurrence:rescheduled"), true);
});

test("historical goal movement excludes active goals and aggregates only meaningful events", () => {
  const rows = [
    { goalId: "active", title: "Active", eventType: "occurrence:done" },
    { goalId: "old", title: "Old", eventType: "occurrence:done" },
    { goalId: "old", title: "Old", eventType: "occurrence:rescheduled" },
    { goalId: "old", title: "Old", eventType: "task:created" },
  ];
  assert.deepEqual(aggregateHistoricalGoalMovement(rows, new Set(["active"])), [
    { goalId: "old", title: "Old", done: 1, rescheduled: 1 },
  ]);
});

test("habit stats use only terminal habit occurrences", () => {
  assert.deepEqual(habitCompletionStats(["done", "done", "skipped", "open"]), { done: 2, total: 3, missed: 1, rate: 67 });
});

test("habit stats report null rate before there is terminal data", () => {
  assert.deepEqual(habitCompletionStats(["open", "scheduled"]), { done: 0, total: 0, missed: 0, rate: null });
});

test("historical movement keeps independent counters for multiple goals", () => {
  const rows = [
    { goalId: "g1", title: "One", eventType: "occurrence:done" },
    { goalId: "g2", title: "Two", eventType: "occurrence:rescheduled" },
    { goalId: "g1", title: "One", eventType: "occurrence:done" },
  ];
  assert.deepEqual(aggregateHistoricalGoalMovement(rows, new Set()), [
    { goalId: "g1", title: "One", done: 2, rescheduled: 0 },
    { goalId: "g2", title: "Two", done: 0, rescheduled: 1 },
  ]);
});

test("habit stats report a real zero percent instead of missing data when all attempts were missed", () => {
  assert.deepEqual(habitCompletionStats(["skipped", "elapsed"]), { done: 0, total: 2, missed: 2, rate: 0 });
});


test("weekly review excludes cancelled goals from historical review semantics", () => {
  assert.equal(isWeeklyReviewGoalStatus("active"), true);
  assert.equal(isWeeklyReviewGoalStatus("paused"), true);
  assert.equal(isWeeklyReviewGoalStatus("completed"), true);
  assert.equal(isWeeklyReviewGoalStatus("cancelled"), false);
});
