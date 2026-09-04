import test from "node:test";
import assert from "node:assert/strict";
import { clarificationForCandidates, issueCode, renderValidationReply, unclearReply } from "../../dist/chat/turn-errors.js";
import { bareConfirmationDecision } from "../../dist/core/conversation-control.js";

const issue = (fields) => ({ kind: "domain", index: 0, code: "invalid_action", message: "", ...fields });

test("a rejected action names the failed rule and a concrete fix instead of a generic apology", () => {
  const past = renderValidationReply([issue({ code: "time_past", message: "plannedStartAt must not be in the past when creating a one-time task" })], "ru", 1);
  assert.match(past, /уже в прошлом/i);

  const stale = renderValidationReply([issue({ kind: "reference", code: "stale", message: "target task is missing or stale" })], "ru", 1);
  assert.match(stale, /изменились после того, как я прочитал/i);
  assert.match(renderValidationReply([issue({ kind: "reference", code: "stale", message: "target task is missing or stale" })], "en", 1), /changed after I read it/);

  const unmapped = renderValidationReply([issue({ message: "some brand new rule failed" })], "ru", 1);
  assert.match(unmapped, /some brand new rule failed/);
});

test("an unknown code still maps through the message when a known rule text matches", () => {
  assert.equal(issueCode({ code: "invalid_action", message: "reminder falls inside quiet hours; ask whether to send exactly" }), "quiet_hours");
  assert.equal(issueCode({ code: "fuzzy_reminder", message: "" }), "fuzzy_reminder");
});

test("a package that cannot be applied says so before naming the reason", () => {
  const reply = renderValidationReply([issue({ code: "time_past", message: "" })], "ru", 3);
  assert.match(reply, /^Ничего не применил — действия из одного сообщения применяются только вместе\./);
});

test("an ambiguous scope asks which one instead of guessing", () => {
  const reply = renderValidationReply([issue({
    kind: "ambiguous", code: "scope_required", message: "cancel one occurrence or the whole series?",
    candidates: [{ id: "occurrence", title: "только это повторение" }, { id: "series", title: "всю серию" }],
  })], "ru", 1);
  assert.match(reply, /только это повторение или всю серию\?/i);
});

test("a missing reference asks for the exact title and never invents one", () => {
  const reply = renderValidationReply([issue({ kind: "reference", code: "ref_not_found", message: "task t9 is not in the current context" })], "ru", 1);
  assert.match(reply, /Не нашёл/);
  assert.doesNotMatch(reply, /t9/);
});

test("candidate clarifications list the titles the user can choose from", () => {
  assert.equal(clarificationForCandidates([{ title: "Созвон" }, { title: "Созвон с Петей" }], "ru"), "Вижу несколько вариантов: «Созвон», «Созвон с Петей». Какой именно?");
});

test("an unusable structured output asks for a rephrase, not a rule text", () => {
  assert.match(unclearReply("ru"), /Не понял/);
  assert.match(unclearReply("en"), /did not get that/);
});

test("only a bare yes or no resolves a pending proposal", () => {
  assert.equal(bareConfirmationDecision("Да"), "confirm");
  assert.equal(bareConfirmationDecision("да!"), "confirm");
  assert.equal(bareConfirmationDecision("ок"), "confirm");
  assert.equal(bareConfirmationDecision("Подходит"), "confirm");
  assert.equal(bareConfirmationDecision("Нет"), "cancel");
  assert.equal(bareConfirmationDecision("отмена"), "cancel");
  // Anything carrying its own instruction must reach the model, not the pending group.
  assert.equal(bareConfirmationDecision("Да, но перенеси на завтра"), null);
  assert.equal(bareConfirmationDecision("Отмени задачу про вакцинацию"), null);
  assert.equal(bareConfirmationDecision(""), null);
});
