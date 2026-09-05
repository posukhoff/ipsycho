import test from "node:test";
import assert from "node:assert/strict";
import { formatLocalDateTime } from "../../.core-dist/time-presentation.js";

test("a local date-time in another year carries the year, so it cannot read as today", () => {
  // Production 2026-08-23: "23.08, 10:00" for a 2027 task looked like a same-day reminder.
  const now = new Date("2026-08-23T07:00:00Z");
  assert.equal(formatLocalDateTime(new Date("2026-12-31T22:30:00Z"), "Europe/Kyiv", now), "01.01.2027, 00:30");
  assert.equal(formatLocalDateTime(new Date("2026-08-23T15:00:00Z"), "Europe/Kyiv", now), "23.08, 18:00");
});
