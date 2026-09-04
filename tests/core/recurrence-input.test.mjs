import test from "node:test";
import assert from "node:assert/strict";
import { compileStructuredRecurrence } from "../../.core-dist/recurrence-input.js";

test("structured recurrence compiles interval, bounds and exclusions", () => {
  assert.deepEqual(
    compileStructuredRecurrence({
      frequency: "weekly",
      interval: 2,
      startsOn: "2026-09-07",
      endsOn: "2026-11-30",
      weekdays: ["MO"],
      excludedLocalDates: ["2026-09-21"],
    }),
    {
      recurrenceRule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
      recurrenceStartLocalDate: "2026-09-07",
      recurrenceEndLocalDate: "2026-11-30",
      recurrenceExcludedLocalDates: ["2026-09-21"],
    },
  );
});

test("structured recurrence rejects unsupported field combinations", () => {
  assert.throws(
    () =>
      compileStructuredRecurrence({
        frequency: "weekly",
        interval: 1,
        startsOn: "2026-09-07",
        localTimes: ["09:00", "18:00"],
      }),
    /several times per occurrence/,
  );
  assert.throws(
    () =>
      compileStructuredRecurrence({
        frequency: "weekly",
        interval: 1,
        startsOn: "2026-09-07",
        localTimes: ["09:00"],
      }),
    /time from the schedule start/,
  );
  assert.throws(
    () =>
      compileStructuredRecurrence(
        {
          frequency: "weekly",
          interval: 1,
          startsOn: "2026-09-07",
          localTimes: ["09:00"],
        },
        { anchorLocalTime: "14:00" },
      ),
    /contradicts the schedule start time/,
  );
  // daily + weekdays at interval 1 is «по будням» and is read as weekly; see the test below.
  assert.throws(
    () =>
      compileStructuredRecurrence({
        frequency: "daily",
        interval: 3,
        startsOn: "2026-09-07",
        weekdays: ["MO"],
      }),
    /weekdays/,
  );
  assert.throws(
    () =>
      compileStructuredRecurrence({
        frequency: "daily",
        interval: 1,
        startsOn: "2026-09-07",
        endsOn: "2026-09-06",
      }),
    /end/,
  );
});

test("weekly recurrence tolerates the single local time its schedule anchor already carries", () => {
  assert.deepEqual(
    compileStructuredRecurrence(
      {
        frequency: "weekly",
        interval: 1,
        startsOn: "2026-08-23",
        weekdays: ["SU"],
        localTimes: ["14:00"],
      },
      { anchorLocalTime: "14:00" },
    ),
    {
      recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=SU",
      recurrenceStartLocalDate: "2026-08-23",
      recurrenceExcludedLocalDates: [],
    },
  );
});

test("«по будням» compiles whether the model calls it daily or weekly", () => {
  const asDaily = compileStructuredRecurrence({
    frequency: "daily",
    interval: 1,
    startsOn: "2026-09-07",
    endsOn: "2026-09-30",
    weekdays: ["MO", "TU", "WE", "TH", "FR"],
    monthDays: null,
    localTimes: null,
    excludedLocalDates: null,
  });
  assert.equal(asDaily.recurrenceRule, "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR");
  assert.equal(asDaily.recurrenceEndLocalDate, "2026-09-30");

  // Every second day with weekdays is genuinely contradictory and stays an error.
  assert.throws(
    () =>
      compileStructuredRecurrence({
        frequency: "daily",
        interval: 2,
        startsOn: "2026-09-07",
        endsOn: null,
        weekdays: ["MO"],
        monthDays: null,
        localTimes: null,
        excludedLocalDates: null,
      }),
    /weekdays are supported only for weekly recurrence/,
  );
});
