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
  const directive = canonicalizeTopicDirective({ mode: "resolve", topicId: "topic", title: "Old title", summary: "Done" });
  assert.equal(directive.title, null);
  assert.equal(validateTopicDirective(directive), null);
});
