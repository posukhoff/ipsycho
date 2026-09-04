import test from "node:test";
import assert from "node:assert/strict";
import { isMinuteInsideRange, isQuietAt } from "../../.core-dist/quiet-hours.js";

const quiet = { enabled: true, weekday: { start: "22:00", end: "08:00" }, weekend: { start: "23:00", end: "09:00" } };

test("overnight range works", () => {
  assert.equal(isMinuteInsideRange(23 * 60, 22 * 60, 8 * 60), true);
  assert.equal(isMinuteInsideRange(7 * 60 + 59, 22 * 60, 8 * 60), true);
  assert.equal(isMinuteInsideRange(12 * 60, 22 * 60, 8 * 60), false);
});
test("Kyiv weekday quiet hours", () => {
  assert.equal(isQuietAt(new Date("2026-08-10T20:30:00Z"), "Europe/Kyiv", quiet), true);
  assert.equal(isQuietAt(new Date("2026-08-10T09:00:00Z"), "Europe/Kyiv", quiet), false);
});
test("disabled quiet hours never block", () => assert.equal(isQuietAt(new Date(), "Europe/Kyiv", { ...quiet, enabled: false }), false));
