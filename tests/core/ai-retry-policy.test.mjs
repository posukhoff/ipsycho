import test from "node:test";
import assert from "node:assert/strict";
import { automaticAiRetryLimit, nextAutomaticAiRetryAt } from "../../.core-dist/ai-retry-policy.js";

test("AI automatic retry policy permits exactly two retries after the initial attempt", () => {
  const now = new Date("2026-08-10T08:00:00.000Z");
  assert.equal(automaticAiRetryLimit(), 2);
  assert.equal(nextAutomaticAiRetryAt(1, now)?.toISOString(), "2026-08-10T08:01:00.000Z");
  assert.equal(nextAutomaticAiRetryAt(2, now)?.toISOString(), "2026-08-10T08:05:00.000Z");
  assert.equal(nextAutomaticAiRetryAt(3, now), null);
});
