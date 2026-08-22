import test from "node:test";
import assert from "node:assert/strict";
import { deadlineUrgency } from "../../.core-dist/deadline-urgency.js";

const now = new Date("2026-08-11T12:00:00Z");
test("deadline urgency grows without changing user-selected importance", () => {
  assert.equal(deadlineUrgency({ dueAt: new Date("2026-09-01T12:00:00Z"), timezone: "Europe/Kyiv", now }), "normal");
  assert.equal(deadlineUrgency({ dueAt: new Date("2026-08-20T12:00:00Z"), timezone: "Europe/Kyiv", now }), "watch");
  assert.equal(deadlineUrgency({ dueAt: new Date("2026-08-16T12:00:00Z"), timezone: "Europe/Kyiv", now }), "high");
  assert.equal(deadlineUrgency({ dueAt: new Date("2026-08-13T12:00:00Z"), timezone: "Europe/Kyiv", now }), "urgent");
});

test("date-only deadline becomes urgent near the end of its local day", () => {
  assert.equal(deadlineUrgency({ dueLocalDate: "2026-08-11", timezone: "Europe/Kyiv", now }), "urgent");
});
