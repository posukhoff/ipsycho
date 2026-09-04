import test from "node:test";
import assert from "node:assert/strict";
import { rescheduledDefinition, rescheduledOccurrenceStatus } from "../../.core-dist/reschedule.js";

const task = {
  kind: "task",
  importance: "normal",
  timeMode: "point",
  timezone: "Europe/Kyiv",
  plannedStartAt: new Date("2026-08-10T09:00:00Z"),
};

test("reschedule replaces concrete point time without leaking old fields", () => {
  const next = rescheduledDefinition(task, { plannedStartAt: new Date("2026-08-11T10:00:00Z") });
  assert.equal(next.plannedStartAt.toISOString(), "2026-08-11T10:00:00.000Z");
  assert.equal("dueAt" in next, false);
});

test("rescheduled future point becomes scheduled", () => {
  const next = rescheduledDefinition(task, { plannedStartAt: new Date("2026-08-11T10:00:00Z") });
  assert.equal(rescheduledOccurrenceStatus(next, new Date("2026-08-10T10:00:00Z")), "scheduled");
});

test("reschedule preserves recurrence metadata while deriving occurrence status", () => {
  const recurring = {
    ...task,
    recurrenceRule: "FREQ=DAILY",
    recurrenceTimezone: "Europe/Kyiv",
    missPolicy: "expire",
  };
  const next = rescheduledDefinition(recurring, { plannedStartAt: new Date("2026-08-11T10:00:00Z") });
  assert.equal(next.recurrenceRule, "FREQ=DAILY");
  assert.equal(rescheduledOccurrenceStatus(next, new Date("2026-08-10T10:00:00Z")), "scheduled");
});

test("one-time concrete task may return to fuzzy planning", () => {
  const next = rescheduledDefinition(task, { fuzzyHorizonText: "в течение осени", reviewAt: new Date("2026-09-01T07:00:00Z") });
  assert.equal(next.timeMode, "fuzzy");
  assert.equal(next.fuzzyHorizonText, "в течение осени");
  assert.equal(next.plannedStartAt, undefined);
});

test("one occurrence of a recurring series cannot become fuzzy", () => {
  const recurring = { ...task, recurrenceRule: "FREQ=DAILY", recurrenceTimezone: "Europe/Kyiv", missPolicy: "expire" };
  assert.throws(() => rescheduledDefinition(recurring, { fuzzyHorizonText: "к осени", reviewAt: new Date("2026-09-01T07:00:00Z") }));
});

test("a fuzzy task becomes concrete when the reschedule names the target time mode", () => {
  const fuzzy = { ...task, timeMode: "fuzzy", plannedStartAt: undefined, fuzzyHorizonText: "к осени", reviewAt: new Date("2026-09-01T07:00:00Z") };
  delete fuzzy.plannedStartAt;
  const point = rescheduledDefinition(fuzzy, { plannedStartAt: new Date("2026-08-11T10:00:00Z") }, "point");
  assert.equal(point.timeMode, "point");
  assert.equal(point.plannedStartAt.toISOString(), "2026-08-11T10:00:00.000Z");
  assert.equal("fuzzyHorizonText" in point, false);
  assert.equal("reviewAt" in point, false);

  const allDay = rescheduledDefinition(fuzzy, { plannedLocalDate: "2026-08-12" }, "window");
  assert.equal(allDay.timeMode, "window");
  assert.equal(allDay.plannedLocalDate, "2026-08-12");

  const deadline = rescheduledDefinition(fuzzy, { dueLocalDate: "2026-08-15" }, "deadline");
  assert.equal(deadline.timeMode, "deadline");
  assert.equal(deadline.dueLocalDate, "2026-08-15");

  // Without the target mode a fuzzy task cannot silently become a point: the definition is invalid.
  assert.throws(() => rescheduledDefinition(fuzzy, { plannedStartAt: new Date("2026-08-11T10:00:00Z") }));
});

test("targetTimeMode never overrides a return to fuzzy planning", () => {
  const next = rescheduledDefinition(task, { fuzzyHorizonText: "в течение осени", reviewAt: new Date("2026-09-01T07:00:00Z") }, "point");
  assert.equal(next.timeMode, "fuzzy");
});
