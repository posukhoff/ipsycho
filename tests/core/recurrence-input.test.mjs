import test from "node:test";
import assert from "node:assert/strict";
import { compileStructuredRecurrence } from "../../.core-dist/recurrence-input.js";

test("structured recurrence compiles interval, bounds and exclusions", () => {
  assert.deepEqual(compileStructuredRecurrence({
    frequency: "weekly",
    interval: 2,
    startsOn: "2026-09-07",
    endsOn: "2026-11-30",
    weekdays: ["MO"],
    excludedLocalDates: ["2026-09-21"],
  }), {
    recurrenceRule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
    recurrenceStartLocalDate: "2026-09-07",
    recurrenceEndLocalDate: "2026-11-30",
    recurrenceExcludedLocalDates: ["2026-09-21"],
  });
});

test("structured recurrence rejects unsupported field combinations", () => {
  assert.throws(() => compileStructuredRecurrence({
    frequency: "weekly", interval: 1, startsOn: "2026-09-07", localTimes: ["09:00"],
  }), /multiple local times/);
  assert.throws(() => compileStructuredRecurrence({
    frequency: "daily", interval: 1, startsOn: "2026-09-07", weekdays: ["MO"],
  }), /weekdays/);
  assert.throws(() => compileStructuredRecurrence({
    frequency: "daily", interval: 1, startsOn: "2026-09-07", endsOn: "2026-09-06",
  }), /end/);
});
