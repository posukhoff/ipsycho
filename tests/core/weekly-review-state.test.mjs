import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyWeeklyReviewState,
  weeklyReviewProgressFromText,
  mergeWeeklyReviewProgress,
  parseWeeklyReviewState,
  questionForMissingWeeklyDimension,
  weeklyReviewLifecycle,
} from "../../.core-dist/weekly-review-state.js";

const dimension = (summary) => ({ status: "provided", summary });

test("outcome-only weekly answer remains active and asks capacity next", () => {
  const state = mergeWeeklyReviewProgress(null, {
    outcome: dimension("Пять интервью"),
    capacityEnergy: null,
    risks: null,
    minimumSuccess: null,
    commitments: null,
    conclusionRequested: false,
  });
  assert.equal(weeklyReviewLifecycle(state, 0).complete, false);
  assert.match(questionForMissingWeeklyDimension(state), /времени/);
});

test("invalid or old weekly state degrades to recoverable missing coverage", () =>
  assert.deepEqual(parseWeeklyReviewState({ version: 0, outcome: "old" }), emptyWeeklyReviewState()));

test("explicit or limit-forced conclusion labels missing assumptions", () => {
  const state = { ...emptyWeeklyReviewState(), conclusionRequested: true };
  assert.deepEqual(weeklyReviewLifecycle(state, 1), { complete: true, forced: true, assumptionsRequired: true });
  assert.deepEqual(weeklyReviewLifecycle(emptyWeeklyReviewState(), 4), { complete: false, forced: false, assumptionsRequired: false });
  assert.deepEqual(weeklyReviewLifecycle(emptyWeeklyReviewState(), 5), { complete: true, forced: true, assumptionsRequired: true });
});

test("an outcome-only answer supports only the outcome dimension", () => {
  const grounded = weeklyReviewProgressFromText("На следующей неделе хочу получить две оплаченные сессии.");
  assert.ok(grounded.outcome);
  assert.deepEqual([grounded.capacityEnergy, grounded.risks, grounded.minimumSuccess, grounded.commitments, grounded.conclusionRequested], [null, null, null, null, false]);
});

test("weekly evidence grounding recognizes remaining dimensions and final request", () => {
  const grounded = weeklyReviewProgressFromText("Есть 6 часов, риск — полировка вместо разговоров. Минимум — одна сессия, интервью в среду. Дай финальный план.");
  assert.ok(grounded.capacityEnergy && grounded.risks && grounded.minimumSuccess && grounded.commitments && grounded.conclusionRequested);
});

test("one explicit Russian message grounds all five weekly dimensions", () => {
  const text =
    "Результат: отправил два письма, но оплаченных пилотов нет. Энергия 4 из 10, реально есть четыре часа. Риски: недосып и две встречи. Минимум успеха — ещё три письма и один созвон. Обязательства — встреча с Антоном и восстановление сна. Составь финальный план.";
  const grounded = weeklyReviewProgressFromText(text);
  assert.ok(grounded.outcome && grounded.capacityEnergy && grounded.risks && grounded.minimumSuccess && grounded.commitments);
  assert.equal(grounded.conclusionRequested, true);
  const state = mergeWeeklyReviewProgress(null, grounded);
  assert.deepEqual(weeklyReviewLifecycle(state, 1), { complete: true, forced: true, assumptionsRequired: false });
});
