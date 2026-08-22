import test from "node:test";
import assert from "node:assert/strict";
import { formatOccurrenceSchedule, reminderAddsTimingInformation } from "../../.core-dist/time-presentation.js";

const empty = { plannedStartAt: null, plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null };

test("persisted reschedule reports the event at the user's local exact time", () => {
  assert.equal(formatOccurrenceSchedule({
    ...empty,
    timezone: "Europe/Kyiv",
    plannedStartAt: new Date("2026-08-11T17:32:00Z"),
  }), "📅 Запланировано: 11.08, 20:32 (Europe/Kyiv)");
});

test("date-only occurrence is reported without inventing a clock time", () => {
  assert.equal(formatOccurrenceSchedule({ ...empty, timezone: "Europe/Kyiv", dueLocalDate: "2026-08-12" }), "📅 Запланировано: 2026-08-12 (Europe/Kyiv)");
});

test("deadline is shown when a point start is absent", () => {
  assert.equal(formatOccurrenceSchedule({
    ...empty,
    timezone: "Europe/Kyiv",
    dueAt: new Date("2026-01-15T12:00:00Z"),
  }), "📅 Запланировано: 15.01, 14:00 (Europe/Kyiv)");
});

test("reminder at the displayed schedule minute adds no duplicate information", () => {
  const schedule = { ...empty, timezone: "Europe/Kyiv", plannedStartAt: new Date("2026-08-23T07:00:00Z") };
  assert.equal(reminderAddsTimingInformation(schedule, new Date("2026-08-23T07:00:00Z")), false);
  assert.equal(reminderAddsTimingInformation(schedule, new Date("2026-08-23T07:00:45Z")), false);
  assert.equal(reminderAddsTimingInformation(schedule, new Date("2026-08-23T06:45:00Z")), true);
});

test("date-only schedule keeps its concrete reminder visible", () => {
  const schedule = { ...empty, timezone: "Europe/Kyiv", dueLocalDate: "2026-08-23" };
  assert.equal(reminderAddsTimingInformation(schedule, new Date("2026-08-23T06:00:00Z")), true);
});
