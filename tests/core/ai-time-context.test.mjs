import test from "node:test";
import assert from "node:assert/strict";
import { aiTimeContext } from "../../.core-dist/ai-time-context.js";

test("AI receives one server time in UTC and the user's local timezone", () => {
  const now = new Date("2026-08-11T17:30:00.123Z");
  assert.deepEqual(aiTimeContext(now, "Europe/Kyiv"), {
    utc: "2026-08-11T17:30:00.123Z",
    local: "2026-08-11T20:30:00+03:00",
    timezone: "Europe/Kyiv",
    epochMs: now.getTime(),
  });
});

test("the same reference instant stays identical for an AI repair", () => {
  const referenceNow = new Date("2026-10-25T00:30:00.000Z");
  const firstAttempt = aiTimeContext(referenceNow, "Europe/Kyiv");
  const repairedAttempt = aiTimeContext(referenceNow, "Europe/Kyiv");
  assert.deepEqual(repairedAttempt, firstAttempt);
});

test("local offset follows timezone daylight-saving changes", () => {
  assert.equal(aiTimeContext(new Date("2026-01-15T12:00:00Z"), "Europe/Kyiv").local, "2026-01-15T14:00:00+02:00");
  assert.equal(aiTimeContext(new Date("2026-08-11T17:30:00Z"), "Europe/Kyiv").local, "2026-08-11T20:30:00+03:00");
});
