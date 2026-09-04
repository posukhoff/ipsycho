import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewPresentation, removeDanglingContinuation, reviewTopicDirective } from "../../dist/chat/review-turn.js";

const turn = (fields) => ({ reply: "", question: null, actions: [], topic: { mode: "none", title: null, summary: null }, ...fields });

test("weekly prose-only continuation question is promoted to the structured field", () => {
  const result = normalizeReviewPresentation(turn({ reply: "Цель понятна.\nСколько времени реально есть на неделе?" }), "weekly", false);
  assert.equal(result.reply, "Цель понятна.");
  assert.equal(result.question, "Сколько времени реально есть на неделе?");
});

test("a structured question is not repeated when the provider also ends reply with it", () => {
  const question = "Какую цель разбираем?";
  const result = normalizeReviewPresentation(turn({ reply: `Вижу две активные цели.\n\n${question}`, question }));
  assert.equal(result.reply, "Вижу две активные цели.");
  assert.equal(result.question, question);
  assert.equal(normalizeReviewPresentation(turn({ reply: `Уточню одно: **${question}**`, question })).reply, "Уточню одно:");
});

test("a forced weekly conclusion carries neither a question nor actions", () => {
  const result = normalizeReviewPresentation(turn({ reply: "План готов.", question: "Ещё вопрос?", actions: [{ type: "create_task" }] }), "weekly", true);
  assert.equal(result.question, null);
  assert.deepEqual(result.actions, []);
});

test("an evening review keeps the actions the user explicitly asked for", () => {
  const actions = [{ type: "create_task", intent: "explicit" }];
  assert.deepEqual(normalizeReviewPresentation(turn({ reply: "Ок.", actions }), "evening").actions, actions);
});

test("final weekly copy drops dangling optional continuation", () => {
  assert.equal(removeDanglingContinuation("План готов. Если хочешь, могу потом расписать подробнее."), "План готов.");
  assert.equal(removeDanglingContinuation("План готов.\n\nЕсли хочешь, могу расписать подробнее. С чего начнём?"), "План готов.");
});

test("a review turn always develops the review topic", () => {
  const directive = reviewTopicDirective({ mode: "new", title: "Другая тема", summary: null }, "Есть шесть часов на неделе", "weekly");
  assert.equal(directive.mode, "continue");
  assert.equal(directive.title, null);
  assert.match(directive.summary, /^Планирование недели: Есть шесть часов/);
});
