import test from "node:test";
import assert from "node:assert/strict";
import { compactText, quickRescheduleSchedule } from "../../.core-dist/telegram-ux.js";

test("quick reschedule +1h uses an exact instant for point tasks", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const result = quickRescheduleSchedule({ choice: "1h", timeMode: "point", occurrence: { timezone: "Europe/Kyiv" }, now });
  assert.equal(result.plannedStartAt?.toISOString(), "2026-08-11T13:00:00.000Z");
});

test("quick reschedule tomorrow preserves the task local clock time", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");
  const result = quickRescheduleSchedule({
    choice: "tomorrow",
    timeMode: "point",
    occurrence: { timezone: "Europe/Kyiv", plannedStartAt: new Date("2026-08-11T15:30:00.000Z") },
    now,
  });
  assert.equal(result.plannedStartAt?.toISOString(), "2026-08-12T15:30:00.000Z");
});

test("quick reschedule tomorrow keeps date-only deadlines date-only", () => {
  const result = quickRescheduleSchedule({
    choice: "tomorrow",
    timeMode: "deadline",
    occurrence: { timezone: "Europe/Kyiv", dueLocalDate: "2026-08-11" },
    now: new Date("2026-08-11T12:00:00.000Z"),
  });
  assert.deepEqual(result, { dueLocalDate: "2026-08-12" });
});

test("quick evening moves to next evening when today's reference already passed", () => {
  const result = quickRescheduleSchedule({
    choice: "evening",
    timeMode: "point",
    occurrence: { timezone: "Europe/Kyiv" },
    now: new Date("2026-08-11T18:30:00.000Z"),
    eveningReferenceTime: "20:00",
  });
  assert.equal(result.plannedStartAt?.toISOString(), "2026-08-12T17:00:00.000Z");
});

test("window quick reschedule preserves duration", () => {
  const result = quickRescheduleSchedule({
    choice: "1h",
    timeMode: "window",
    occurrence: {
      timezone: "Europe/Kyiv",
      plannedStartAt: new Date("2026-08-11T10:00:00.000Z"),
      plannedEndAt: new Date("2026-08-11T11:30:00.000Z"),
    },
    now: new Date("2026-08-11T12:00:00.000Z"),
  });
  assert.equal(result.plannedStartAt?.toISOString(), "2026-08-11T13:00:00.000Z");
  assert.equal(result.plannedEndAt?.toISOString(), "2026-08-11T14:30:00.000Z");
});

test("compact text bounds Telegram-first responses without splitting into extra blocks", () => {
  const result = compactText(`  ${"x".repeat(20)}\n\n\n${"y".repeat(20)}  `, 30);
  assert.equal(result.length, 30);
  assert.match(result, /…$/u);
  assert.doesNotMatch(result, /\n{3,}/u);
});

test("quick reschedule tomorrow keeps date-only windows date-only", () => {
  const result = quickRescheduleSchedule({
    choice: "tomorrow",
    timeMode: "window",
    occurrence: { timezone: "Europe/Kyiv", plannedLocalDate: "2026-08-11" },
    now: new Date("2026-08-11T12:00:00.000Z"),
  });
  assert.deepEqual(result, { plannedLocalDate: "2026-08-12" });
});
