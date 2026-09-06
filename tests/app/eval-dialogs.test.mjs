import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dialogs = JSON.parse(readFileSync("tests/eval/dialogs.json", "utf8"));
const personas = JSON.parse(readFileSync("tests/eval/personas.json", "utf8"));
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
  "activeTasks",
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
  "nextActionSet",
  "checklistItems",
  "maxUserTurns",
]);

test("every eval case has a unique id, a message and only known expectation keys", () => {
  const ids = new Set();
  // One namespace across both files: --only takes a bare id and must never be ambiguous.
  for (const item of [...dialogs.cases, ...personas.cases]) {
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

test("every persona scenario states a goal and a turn budget, and grades only stored state", () => {
  for (const item of personas.cases) {
    assert.ok(item.persona, `${item.id}: not a persona case`);
    assert.equal(typeof item.persona.goal, "string");
    assert.ok(item.persona.goal.length > 20, `${item.id}: goal too thin to steer a conversation`);
    assert.equal(typeof item.persona.traits, "string");
    // A scenario without a cap can run until the model gets bored, at a provider call per turn.
    assert.ok(Number.isInteger(item.persona.maxTurns) && item.persona.maxTurns >= 2 && item.persona.maxTurns <= 8, `${item.id}: maxTurns out of range`);
    // The fake user drives the dialog; it must never be the one answering the follow-up too.
    assert.ok(!item.then, `${item.id}: a persona case cannot also carry a scripted follow-up`);
    assert.ok(item.expect.maxUserTurns <= item.persona.maxTurns, `${item.id}: maxUserTurns exceeds the scenario's own budget`);
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
