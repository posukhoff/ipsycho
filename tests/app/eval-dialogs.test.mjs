import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dialogs = JSON.parse(readFileSync("tests/eval/dialogs.json", "utf8"));
// Every key the runner knows how to check. A typo in a new case would otherwise pass silently.
const EXPECT_KEYS = new Set([
  "settles",
  "maxProviderCalls",
  "applied",
  "pending",
  "tasksCreated",
  "questionExpected",
  "titleMatches",
  "memoriesSaved",
  "goalLinks",
  "reminderCount",
  "occurrencesRescheduled",
  "occurrencesDone",
  "tasksCancelled",
  "habitTasks",
  "recurrenceMatches",
  "recurrenceEnds",
  "exclusions",
  "hasLocalDateOnly",
  "settingsChanged",
  "timezone",
  "replyMentions",
  "replyLanguage",
  "startLocalTime",
  "startNotBeforeLocalTime",
  "startOffsetDays",
  "startWithinHours",
  "durationMinutes",
  "weekday",
]);

test("every eval case has a unique id, a message and only known expectation keys", () => {
  const ids = new Set();
  for (const item of dialogs.cases) {
    assert.ok(item.id && !ids.has(item.id), `duplicate or missing id: ${item.id}`);
    ids.add(item.id);
    assert.equal(typeof item.message, "string");
    assert.ok(item.message.length > 5, `${item.id}: message too short`);
    assert.ok(["ru", "uk", "en"].includes(item.language), `${item.id}: unknown language`);
    for (const expect of [item.expect, item.then?.expect].filter(Boolean)) {
      assert.ok(Object.keys(expect).length, `${item.id}: empty expectations`);
      for (const key of Object.keys(expect)) assert.ok(EXPECT_KEYS.has(key), `${item.id}: unknown expectation ${key}`);
    }
  }
});

test("the nine production phrasings of AGENT_FLOW §2.7 are all covered, plus the card sequence", () => {
  const fromFlow = dialogs.cases.filter((item) => item.source === "AGENT_FLOW §2.7");
  assert.equal(fromFlow.length, 9);
  assert.ok(dialogs.cases.some((item) => item.then?.message === "да"));
  assert.ok(dialogs.cases.some((item) => item.language === "uk"));
  assert.ok(dialogs.cases.some((item) => item.language === "en"));
  assert.ok(dialogs.cases.some((item) => item.expect.memoriesSaved || item.expect.startNotBeforeLocalTime));
  assert.ok(dialogs.cases.some((item) => item.expect.settingsChanged));
  assert.ok(dialogs.cases.length >= 21);
  // The two production failures of 2026-09-05: a split that lost an item, a merge that left a duplicate.
  assert.ok(dialogs.cases.some((item) => item.id === "split-into-separate-task"));
  assert.ok(dialogs.cases.some((item) => item.id === "merge-two-tasks"));
});
