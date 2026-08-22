import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewTurn, normalizeWeeklyReviewActions, removeDanglingContinuation } from "../../dist/chat/chat.service.js";

test("weekly prose-only continuation question is promoted to the structured field", () => {
  const turn = normalizeReviewTurn({ reply: "Цель понятна.\nСколько времени реально есть на неделе?", question: null, actions: [] }, "weekly", false);
  assert.equal(turn.reply, "Цель понятна.");
  assert.equal(turn.question, "Сколько времени реально есть на неделе?");
});

test("final weekly copy drops dangling optional continuation", () => {
  assert.equal(removeDanglingContinuation("План готов. Если хочешь, могу потом расписать подробнее."), "План готов.");
});

test("weekly advice cannot create pending work, while explicit task changes become task_batch", () => {
  const create = {
    type: "create_task", source: "ai_inferred", confidence: 0.8, criticalExplicit: false, habitModeExplicit: false,
    title: "Предложение", why: null, nextAction: null, context: null, checklist: null, goalLink: null,
    definition: { kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv", plannedStartAt: "2026-09-01T06:00:00Z", plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null, fuzzyHorizonText: null, reviewAt: null, recurrenceRule: null, recurrenceTimezone: null, missPolicy: null, habitMode: false, minimumAction: null, desiredAction: null, habitTrigger: null },
  };
  assert.deepEqual(normalizeWeeklyReviewActions([create], "Составь план, ничего не меняй"), []);
  const accepted = normalizeWeeklyReviewActions([{ ...create, source: "user_explicit" }], "Создай эту задачу");
  assert.equal(accepted[0].type, "task_batch");
  assert.equal(accepted[0].steps.length, 1);
  assert.deepEqual(
    normalizeWeeklyReviewActions([{ ...create, source: "user_explicit" }], "Создай эту задачу", false),
    [{ ...create, source: "user_explicit" }],
  );
});
