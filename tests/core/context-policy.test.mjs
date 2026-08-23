import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeTopicDirective, goalLinkDisposition, memoryDisposition, validateTopicDirective } from "../../.core-dist/context-policy.js";

test("explicit non-sensitive memory may save immediately", () => {
  assert.equal(memoryDisposition({ source: "user_explicit", sensitive: false }), "apply");
  assert.equal(memoryDisposition({ source: "user_explicit", sensitive: true }), "confirm");
  assert.equal(memoryDisposition({ source: "ai_inferred", sensitive: false }), "confirm");
});

test("high-confidence inferred goal link may apply with undo", () => {
  assert.equal(goalLinkDisposition({ source: "ai_inferred", confidence: 0.95 }), "apply");
  assert.equal(goalLinkDisposition({ source: "ai_inferred", confidence: 0.75 }), "confirm");
  assert.equal(goalLinkDisposition({ source: "user_explicit", confidence: 0.2 }), "apply");
});

test("topic directives reject invented or incomplete shapes", () => {
  assert.equal(validateTopicDirective({ mode: "new", topicId: null, title: "Звонок", summary: "Пользователь избегает звонка" }), null);
  assert.match(validateTopicDirective({ mode: "new", topicId: "x", title: "Звонок", summary: "summary" }), /must not provide/);
  assert.match(validateTopicDirective({ mode: "switch", topicId: null, title: null, summary: "summary" }), /requires topicId/);
  assert.equal(validateTopicDirective({ mode: "none", topicId: null, title: null, summary: null }), null);
});

test("resolved topic ignores a carried-over title without weakening other validation", () => {
  const directive = canonicalizeTopicDirective({ mode: "resolve", topicId: "3f2b9c1e-6d4a-4b8f-9a1c-2e5d7f8a9b0c", title: "Old title", summary: "Done" });
  assert.equal(directive.title, null);
  assert.equal(validateTopicDirective(directive), null);
});

test("a non-uuid topicId never reaches the database", () => {
  // Production 2026-08-23: the model echoed the mode word as the ID and the uuid cast crashed the turn.
  const directive = canonicalizeTopicDirective({ mode: "continue", topicId: "none", title: null, summary: "Summary" });
  assert.equal(directive.topicId, null);
  assert.match(validateTopicDirective(directive), /requires topicId/);
  assert.match(validateTopicDirective({ mode: "switch", topicId: "Soulmate Scan", title: null, summary: "Summary" }), /listed topicId/);
  assert.equal(canonicalizeTopicDirective({ mode: "none", topicId: "none", title: null, summary: null }).topicId, null);
});
