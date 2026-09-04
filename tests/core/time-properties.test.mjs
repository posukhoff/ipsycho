import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { daysBetweenLocalDates, formatLocalDate, localDateAndTimeToUtc, localDateAt, localDateTimeAt, localDateTimeToUtc, shiftLocalDate } from "../../.core-dist/timezone.js";
import { buildRecurringOccurrences } from "../../.core-dist/recurrence.js";

// Zones with a spring gap and an autumn overlap, half-hour and 45-minute offsets, southern
// hemisphere DST and a zone that dropped DST recently. Every invariant below must hold in all.
const ZONES = ["Europe/Kyiv", "Europe/Lisbon", "America/Santiago", "Australia/Lord_Howe", "Pacific/Chatham", "Asia/Tehran", "America/St_Johns", "Asia/Kolkata", "UTC"];
const zone = fc.constantFrom(...ZONES);
const instant = fc.integer({ min: Date.UTC(2024, 0, 1), max: Date.UTC(2028, 11, 31) }).map((ms) => new Date(Math.floor(ms / 1000) * 1000));
const localDate = fc.date({ min: new Date("2024-01-01T00:00:00Z"), max: new Date("2028-12-31T00:00:00Z"), noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10));
const localTime = fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 })).map(([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
const RUNS = { numRuns: 300 };

test("wall clock → UTC → wall clock is the identity, and an existing instant maps to itself or the first of two overlapping ones", () => {
  fc.assert(
    fc.property(instant, zone, (at, tz) => {
      const parts = localDateTimeAt(at, tz);
      const back = localDateTimeToUtc(parts, tz);
      assert.equal(back.dstAdjusted, false);
      assert.deepEqual(localDateTimeAt(back.date, tz), parts);
      assert.ok(back.date.getTime() <= at.getTime());
      assert.ok(at.getTime() - back.date.getTime() <= 60 * 60_000);
    }),
    RUNS,
  );
});

test("later wall-clock time never maps to an earlier instant; a nonexistent time moves forward, never back", () => {
  fc.assert(
    fc.property(localDate, localTime, localTime, zone, (date, a, b, tz) => {
      const [earlier, later] = a <= b ? [a, b] : [b, a];
      const first = localDateAndTimeToUtc(date, earlier, tz);
      const second = localDateAndTimeToUtc(date, later, tz);
      assert.ok(first.date.getTime() <= second.date.getTime());
      for (const result of [first, second]) {
        const round = localDateTimeAt(result.date, tz);
        assert.equal(formatLocalDate(round), date);
        if (!result.dstAdjusted) assert.equal(`${String(round.hour).padStart(2, "0")}:${String(round.minute).padStart(2, "0")}`, result === first ? earlier : later);
      }
    }),
    RUNS,
  );
});

test("shifting a local date and measuring the distance back agree", () => {
  fc.assert(
    fc.property(localDate, fc.integer({ min: -800, max: 800 }), (date, days) => {
      const shifted = shiftLocalDate(date, days);
      assert.equal(daysBetweenLocalDates(date, shifted), days);
      assert.equal(shiftLocalDate(shifted, -days), date);
    }),
    RUNS,
  );
});

test("a daily point series yields exactly one occurrence per local date through every DST boundary, at the same wall time unless the time does not exist", () => {
  fc.assert(
    fc.property(localDate, localTime, zone, fc.integer({ min: 0, max: 45 }), (seedDate, time, tz, horizonDays) => {
      const seedStart = localDateAndTimeToUtc(seedDate, time, tz);
      fc.pre(!seedStart.dstAdjusted);
      const now = localDateAndTimeToUtc(seedDate, "00:00", tz).date;
      const task = {
        kind: "task",
        importance: "normal",
        timeMode: "point",
        timezone: tz,
        plannedStartAt: seedStart.date,
        recurrenceRule: "FREQ=DAILY",
        recurrenceTimezone: tz,
        missPolicy: "expire",
      };
      const occurrences = buildRecurringOccurrences(task, now, horizonDays);
      const today = localDateAt(now, tz);
      const expected = Array.from({ length: horizonDays + 1 }, (_, index) => shiftLocalDate(today, index));
      assert.deepEqual(
        occurrences.map((item) => item.recurrenceKey),
        expected,
      );
      for (const item of occurrences) {
        const local = localDateTimeAt(item.plannedStartAt, tz);
        assert.equal(formatLocalDate(local), item.recurrenceKey);
        const wall = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
        if (item.dstAdjusted) assert.ok(wall > time, `${tz} ${item.recurrenceKey}: adjusted ${wall} must be after ${time}`);
        else assert.equal(wall, time);
      }
      for (let index = 1; index < occurrences.length; index += 1) {
        assert.ok(occurrences[index].plannedStartAt > occurrences[index - 1].plannedStartAt);
      }
    }),
    RUNS,
  );
});

test("an inclusive end date is the last occurrence and excluded dates vanish without moving the others", () => {
  fc.assert(
    fc.property(localDate, zone, fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }), (seedDate, tz, endOffset, excludeOffset) => {
      const now = localDateAndTimeToUtc(seedDate, "00:00", tz).date;
      const endDate = shiftLocalDate(seedDate, endOffset);
      const excluded = shiftLocalDate(seedDate, excludeOffset);
      const base = {
        kind: "task",
        importance: "normal",
        timeMode: "window",
        timezone: tz,
        plannedLocalDate: seedDate,
        recurrenceRule: "FREQ=DAILY",
        recurrenceTimezone: tz,
        missPolicy: "expire",
        recurrenceEndLocalDate: endDate,
      };
      const bounded = buildRecurringOccurrences(base, now, 60);
      assert.equal(bounded.length, endOffset + 1);
      assert.equal(bounded[bounded.length - 1].recurrenceKey, endDate);
      const withExclusion = buildRecurringOccurrences({ ...base, recurrenceExcludedLocalDates: [excluded] }, now, 60);
      assert.deepEqual(
        withExclusion.map((item) => item.recurrenceKey),
        bounded.map((item) => item.recurrenceKey).filter((key) => key !== excluded),
      );
    }),
    RUNS,
  );
});
