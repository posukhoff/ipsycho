import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTopicDirective } from "../../.core-dist/context-policy.js";

test("none drops carried topic data", () => {
  assert.deepEqual(normalizeTopicDirective({ mode: "none", title: "x", summary: "y" }, true), { mode: "none", title: null, summary: null });
});

test("new without a title degrades instead of failing", () => {
  assert.deepEqual(normalizeTopicDirective({ mode: "new", title: "  ", summary: "обсуждаем звонок" }, true), { mode: "continue", title: null, summary: "обсуждаем звонок" });
  assert.deepEqual(normalizeTopicDirective({ mode: "new", title: null, summary: null }, false), { mode: "none", title: null, summary: null });
  assert.deepEqual(normalizeTopicDirective({ mode: "new", title: "Звонок клиенту", summary: null }, false), { mode: "new", title: "Звонок клиенту", summary: "Звонок клиенту" });
});

test("continue and resolve address the active topic or degrade when there is none", () => {
  assert.deepEqual(normalizeTopicDirective({ mode: "continue", title: "Новое имя", summary: "итог" }, true), { mode: "continue", title: "Новое имя", summary: "итог" });
  assert.deepEqual(normalizeTopicDirective({ mode: "resolve", title: "Новое имя", summary: "итог" }, true), { mode: "resolve", title: null, summary: "итог" });
  assert.deepEqual(normalizeTopicDirective({ mode: "continue", title: "Звонок", summary: "итог" }, false), { mode: "new", title: "Звонок", summary: "итог" });
  assert.deepEqual(normalizeTopicDirective({ mode: "resolve", title: null, summary: "итог" }, false), { mode: "none", title: null, summary: null });
});
