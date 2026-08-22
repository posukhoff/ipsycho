import test from "node:test";
import assert from "node:assert/strict";
import { emptyWeeklyReviewState, mergeWeeklyReviewProgress, parseWeeklyReviewState, questionForMissingWeeklyDimension, weeklyReviewLifecycle } from "../../.core-dist/weekly-review-state.js";

const dimension = (summary) => ({ status: "provided", summary });

test("outcome-only weekly answer remains active and asks capacity next", () => {
  const state = mergeWeeklyReviewProgress(null, { outcome: dimension("Пять интервью"), capacityEnergy: null, risks: null, minimumSuccess: null, commitments: null, conclusionRequested: false });
  assert.equal(weeklyReviewLifecycle(state, 0).complete, false);
  assert.match(questionForMissingWeeklyDimension(state), /времени/);
});

test("invalid or old weekly state degrades to recoverable missing coverage", () => assert.deepEqual(parseWeeklyReviewState({ version: 0, outcome: "old" }), emptyWeeklyReviewState()));

test("explicit or limit-forced conclusion labels missing assumptions", () => {
  const state = { ...emptyWeeklyReviewState(), conclusionRequested: true };
  assert.deepEqual(weeklyReviewLifecycle(state, 1), { complete: true, forced: true, assumptionsRequired: true });
  assert.deepEqual(weeklyReviewLifecycle(emptyWeeklyReviewState(), 3), { complete: true, forced: true, assumptionsRequired: true });
});
