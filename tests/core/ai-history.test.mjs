import test from "node:test";
import assert from "node:assert/strict";
import { budgetHistory } from "../../.core-dist/ai-history.js";

test("long messages are shortened and the oldest ones dropped until the history fits", () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i}:${"x".repeat(2_000)}` }));
  const kept = budgetHistory(messages, { perMessage: 500, total: 2_000 });
  assert.ok(kept.every((message) => message.content.length <= 500));
  assert.equal(kept.length, 4);
  assert.match(kept[0].content, /^6:/);
  assert.match(kept.at(-1).content, /^9:/);
  assert.deepEqual(budgetHistory([{ role: "user", content: "hi" }]), [{ role: "user", content: "hi" }]);
});
