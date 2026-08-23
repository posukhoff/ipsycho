import test from "node:test";
import assert from "node:assert/strict";
import { disabledTaskBatchReply, rejectedActionReply, normalizeReviewTurn, normalizeWeeklyReviewActions, removeDanglingContinuation, shouldRetryActionlessTaskBatch } from "../../dist/chat/chat.service.js";

test("weekly prose-only continuation question is promoted to the structured field", () => {
  const turn = normalizeReviewTurn({ reply: "Цель понятна.\nСколько времени реально есть на неделе?", question: null, actions: [] }, "weekly", false);
  assert.equal(turn.reply, "Цель понятна.");
  assert.equal(turn.question, "Сколько времени реально есть на неделе?");
});

test("a structured question is not repeated when the provider also ends reply with it", () => {
  const question = "Какую цель разбираем?";
  const turn = normalizeReviewTurn({ reply: `Вижу две активные цели.\n\n${question}`, question, actions: [] });
  assert.equal(turn.reply, "Вижу две активные цели.");
  assert.equal(turn.question, question);
  const bold = normalizeReviewTurn({ reply: `Уточню одно: **${question}**`, question, actions: [] });
  assert.equal(bold.reply, "Уточню одно:");
});

test("an actionless explicit grouped task request gets one structured repair", () => {
  assert.equal(shouldRetryActionlessTaskBatch([], "Сделай одним пакетом: создай задачу и перенеси встречу", true), true);
  assert.equal(shouldRetryActionlessTaskBatch([], "Как лучше объединить эти задачи?", true), false);
  assert.equal(shouldRetryActionlessTaskBatch([], "Сделай одним пакетом: создай задачу", false), false);
});

test("disabled mixed-operation reply is truthful and does not reconfirm supplied time", () => {
  const reply = disabledTaskBatchReply("ru", "Перенеси созвон на четверг в 16:00 и добавь задачу");
  assert.match(reply, /пакеты сейчас выключены/);
  assert.match(reply, /ничего не изменил/);
  assert.doesNotMatch(reply, /16:00|верно|подтверд/);
  assert.match(disabledTaskBatchReply("en", "create a task and reschedule a meeting"), /made no changes/);
});

test("final weekly copy drops dangling optional continuation", () => {
  assert.equal(removeDanglingContinuation("План готов. Если хочешь, могу потом расписать подробнее."), "План готов.");
  assert.equal(removeDanglingContinuation("План готов.\n\nЕсли хочешь, могу расписать подробнее. С чего начнём?"), "План готов.");
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

test("a rejected action names the failed rule and a concrete fix instead of a generic apology", () => {
  const recurrence = rejectedActionReply(["action 1: localTimes 09:00 contradicts the schedule start time 14:00"], "ru");
  assert.match(recurrence, /время повтора и время старта/i);
  assert.doesNotMatch(recurrence, /не смог безопасно определить/i);

  const stale = rejectedActionReply(["target task is missing or stale"], "ru");
  assert.match(stale, /изменились после того, как я прочитал/i);

  const unmapped = rejectedActionReply(["action 1: some brand new rule failed"], "ru");
  assert.match(unmapped, /some brand new rule failed/);

  assert.match(rejectedActionReply(["target task is missing or stale"], "en"), /changed after I read it/);
});
