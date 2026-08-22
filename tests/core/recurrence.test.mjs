import test from "node:test";
import assert from "node:assert/strict";
import { buildOneTimeOccurrence, buildRecurringOccurrences, parseRecurrenceRule } from "../../.core-dist/recurrence.js";

test("recurrence parser accepts the supported subset", () => {
  assert.deepEqual(parseRecurrenceRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH"), {
    freq: "WEEKLY",
    interval: 2,
    byDay: ["MO", "TH"],
  });
});

test("daily recurrence supports several explicit local times", () => {
  assert.deepEqual(parseRecurrenceRule("FREQ=DAILY;BYTIME=09:00,14:30,21:00"), {
    freq: "DAILY", interval: 1, byTime: ["09:00", "14:30", "21:00"],
  });
  const occurrences = buildRecurringOccurrences({
    kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv",
    plannedStartAt: new Date("2026-08-11T06:00:00Z"), // 09:00 Kyiv, anchor time only
    recurrenceRule: "FREQ=DAILY;BYTIME=09:00,14:30,21:00", recurrenceTimezone: "Europe/Kyiv", missPolicy: "expire",
  }, new Date("2026-08-11T05:00:00Z"), 0);
  assert.deepEqual(occurrences.map((item) => item.recurrenceKey), ["2026-08-11T09:00", "2026-08-11T14:30", "2026-08-11T21:00"]);
  assert.deepEqual(occurrences.map((item) => item.plannedStartAt.toISOString()), [
    "2026-08-11T06:00:00.000Z", "2026-08-11T11:30:00.000Z", "2026-08-11T18:00:00.000Z",
  ]);
  assert.equal(occurrences[0].expiresAt.toISOString(), "2026-08-11T11:30:00.000Z");
});

test("multiple daily times do not backfill slots before the series starts", () => {
  const occurrences = buildRecurringOccurrences({
    kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv",
    plannedStartAt: new Date("2026-08-11T11:30:00Z"), // 14:30 Kyiv
    recurrenceRule: "FREQ=DAILY;BYTIME=09:00,14:30,21:00", recurrenceTimezone: "Europe/Kyiv", missPolicy: "expire",
  }, new Date("2026-08-11T10:00:00Z"), 1);
  assert.deepEqual(occurrences.map((item) => item.recurrenceKey), [
    "2026-08-11T14:30", "2026-08-11T21:00", "2026-08-12T09:00", "2026-08-12T14:30", "2026-08-12T21:00",
  ]);
});

test("recurrence parser rejects unsupported fields", () => {
  assert.throws(() => parseRecurrenceRule("FREQ=DAILY;COUNT=4"), /unsupported recurrence field/);
  assert.throws(() => parseRecurrenceRule("FREQ=DAILY;BYTIME="), /invalid BYTIME/);
  assert.throws(() => parseRecurrenceRule("FREQ=DAILY;BYTIME=09:00,09:00"), /distinct/);
  assert.throws(() => parseRecurrenceRule("FREQ=WEEKLY;BYTIME=09:00"), /DAILY/);
});

test("one-time fuzzy task has no occurrence", () => {
  const result = buildOneTimeOccurrence({
    kind: "task",
    importance: "normal",
    timeMode: "fuzzy",
    timezone: "Europe/Kyiv",
    fuzzyHorizonText: "на следующей неделе",
    reviewAt: new Date("2026-08-10T06:00:00Z"),
  }, new Date("2026-08-09T10:00:00Z"));
  assert.equal(result, null);
});

test("daily point recurrence materializes rolling window and point expiry", () => {
  const occurrences = buildRecurringOccurrences({
    kind: "task",
    importance: "normal",
    timeMode: "point",
    timezone: "Europe/Kyiv",
    plannedStartAt: new Date("2026-08-09T19:00:00Z"), // 22:00 Kyiv
    recurrenceRule: "FREQ=DAILY",
    recurrenceTimezone: "Europe/Kyiv",
    missPolicy: "expire",
  }, new Date("2026-08-09T12:00:00Z"), 2);

  assert.equal(occurrences.length, 3);
  assert.equal(occurrences[0].plannedStartAt.toISOString(), "2026-08-09T19:00:00.000Z");
  assert.equal(occurrences[0].expiresAt.toISOString(), "2026-08-10T19:00:00.000Z");
  assert.equal(occurrences[0].status, "scheduled");
});

test("weekly BYDAY uses local calendar dates", () => {
  const occurrences = buildRecurringOccurrences({
    kind: "task",
    importance: "normal",
    timeMode: "point",
    timezone: "Europe/Kyiv",
    plannedStartAt: new Date("2026-08-10T06:00:00Z"), // Monday 09:00
    recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,WE",
    recurrenceTimezone: "Europe/Kyiv",
    missPolicy: "carry_over",
  }, new Date("2026-08-10T05:00:00Z"), 7);

  assert.deepEqual(occurrences.map((x) => x.recurrenceKey), ["2026-08-10", "2026-08-12", "2026-08-17"]);
});

test("monthly day 31 skips months without that day", () => {
  const occurrences = buildRecurringOccurrences({
    kind: "task",
    importance: "normal",
    timeMode: "point",
    timezone: "Europe/Kyiv",
    plannedStartAt: new Date("2026-01-31T08:00:00Z"),
    recurrenceRule: "FREQ=MONTHLY;BYMONTHDAY=31",
    recurrenceTimezone: "Europe/Kyiv",
    missPolicy: "carry_over",
  }, new Date("2026-01-30T08:00:00Z"), 70);

  assert.deepEqual(occurrences.map((x) => x.recurrenceKey), ["2026-01-31", "2026-03-31"]);
});

test("last visible expire occurrence keeps next boundary beyond rolling window", () => {
  const occurrences = buildRecurringOccurrences({
    kind: "task",
    importance: "normal",
    timeMode: "point",
    timezone: "Europe/Kyiv",
    plannedStartAt: new Date("2026-08-09T19:00:00Z"),
    recurrenceRule: "FREQ=DAILY;INTERVAL=2",
    recurrenceTimezone: "Europe/Kyiv",
    missPolicy: "expire",
  }, new Date("2026-08-09T12:00:00Z"), 3);

  assert.deepEqual(occurrences.map((x) => x.recurrenceKey), ["2026-08-09", "2026-08-11"]);
  assert.equal(occurrences.at(-1).expiresAt.toISOString(), "2026-08-13T19:00:00.000Z");
});

test("deadline-only recurring task keeps one current occurrence and schedules later projections", () => {
  const occurrences = buildRecurringOccurrences({
    kind: "task",
    importance: "required",
    timeMode: "deadline",
    timezone: "Europe/Kyiv",
    dueAt: new Date("2026-08-14T15:00:00Z"),
    recurrenceRule: "FREQ=WEEKLY",
    recurrenceTimezone: "Europe/Kyiv",
    missPolicy: "carry_over",
  }, new Date("2026-08-10T10:00:00Z"), 14);

  assert.equal(occurrences[0].status, "open");
  assert.equal(occurrences[1].status, "scheduled");
});
