import test from "node:test";
import assert from "node:assert/strict";
import { clarificationForCandidates, hasExplanation, issueCode, renderValidationReply, unclearReply } from "../../dist/chat/turn-errors.js";
import { bareConfirmationDecision } from "../../dist/core/conversation-control.js";

const issue = (fields) => ({ kind: "domain", index: 0, code: "invalid_action", message: "", ...fields });

test("a rejected action names the failed rule and a concrete fix instead of a generic apology", () => {
  const past = renderValidationReply([issue({ code: "time_past", message: "plannedStartAt must not be in the past when creating a one-time task" })], "ru", 1);
  assert.match(past, /уже в прошлом/i);

  const stale = renderValidationReply([issue({ kind: "reference", code: "stale", message: "target task is missing or stale" })], "ru", 1);
  assert.match(stale, /изменились после того, как я прочитал/i);
  assert.match(renderValidationReply([issue({ kind: "reference", code: "stale", message: "target task is missing or stale" })], "en", 1), /changed after I read it/);

  // An unmapped rule gets a plain sentence; its English text is for the log, never the user.
  const unmapped = renderValidationReply([issue({ message: "some brand new rule failed" })], "ru", 1);
  assert.doesNotMatch(unmapped, /some brand new rule failed/);
  assert.match(unmapped, /Не сохранил: не сработало одно из правил/);
  assert.doesNotMatch(unmapped, /[A-Za-z]{4,}/);
  assert.equal(hasExplanation("time_past"), true);
  assert.equal(hasExplanation("brand_new"), false);
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

/**
 * Every reference/domain code the resolver can raise must have its own copy: the whole point
 * of dropping the second model call is that the deterministic answer is at least as useful,
 * and an English rule text pasted into a Russian chat is what the old flow did.
 */
test("every resolver code the plan enumerates answers in the user's language, not in rule text", () => {
  const codes = [
    "ref_not_found", "ref_kind_mismatch", "fuzzy_reminder", "fuzzy_no_occurrence", "no_current_occurrence",
    "task_not_active", "skip_one_time", "series_state_unsupported", "not_recurring", "duplicate_action",
    "already_linked", "not_linked", "recurring_fuzzy", "stale", "time_past",
  ];
  for (const code of codes) {
    const reply = renderValidationReply([issue({ code, message: `${code} rule text that must never be shown` })], "ru", 1);
    assert.doesNotMatch(reply, /[A-Za-z]{4,}/u, `${code} leaks its rule text`);
    assert.ok(reply.length > 20, `${code} has no copy`);
    for (const locale of ["uk", "en"]) {
      assert.ok(renderValidationReply([issue({ code, message: "" })], locale, 1).length > 20, `${code} has no ${locale} copy`);
    }
  }
});

test("a skipped one-time task and a series-only state are told apart", () => {
  assert.match(renderValidationReply([issue({ code: "skip_one_time", message: "" })], "ru", 1), /нельзя пропустить/u);
  assert.match(renderValidationReply([issue({ code: "series_state_unsupported", message: "" })], "ru", 1), /всей серии/u);
  assert.match(renderValidationReply([issue({ code: "not_recurring", message: "" })], "ru", 1), /одноразовая задача/u);
});

test("a repeated action is reported as a repetition rather than applied twice in silence", () => {
  const reply = renderValidationReply([issue({ code: "duplicate_action", message: "the same action is repeated in one message" })], "ru", 2);
  assert.match(reply, /^Ничего не применил/u);
  assert.match(reply, /повторяется дважды/u);
});

test("every resolver and conversion code has user-facing copy in all three languages", () => {
  const codes = [
    "time_past", "recurring_fuzzy", "stale", "already_linked", "not_linked", "ref_not_found", "ref_kind_mismatch",
    "fuzzy_reminder", "fuzzy_no_occurrence", "no_current_occurrence", "task_not_active", "skip_one_time",
    "series_state_unsupported", "not_recurring", "duplicate_action", "quiet_hours", "reason_required",
    "date_only_offset", "terminal_occurrence", "habit_not_eligible", "settings_stale", "series_time_mode",
    "timezone", "ref_required", "goal_title", "empty_patch", "memory_shape", "blank_field", "reminder_shape",
    "recurrence_scope", "note_not_allowed", "settings_shape", "plan_empty", "task_definition", "schedule",
    "recurrence", "checklist", "reminder_anchor",
  ];
  for (const code of codes) {
    for (const language of ["ru", "uk", "en"]) {
      const reply = renderValidationReply([issue({ code, message: "internal rule text that must not surface" })], language, 1);
      assert.doesNotMatch(reply, /internal rule text/, `${code}/${language} leaked the rule text`);
      assert.ok(reply.trim().length > 10, `${code}/${language} has no copy`);
    }
  }
});
