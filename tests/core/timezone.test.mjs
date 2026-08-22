import test from "node:test";
import assert from "node:assert/strict";
import { localDateAndTimeToUtc, localDateAt, localDateTimeAt, shiftLocalDate } from "../../.core-dist/timezone.js";

test("local date conversion preserves Kyiv wall clock", () => {
  const result = localDateAndTimeToUtc("2026-08-10", "09:30", "Europe/Kyiv");
  assert.equal(result.date.toISOString(), "2026-08-10T06:30:00.000Z");
  assert.equal(result.dstAdjusted, false);
  assert.equal(localDateAt(result.date, "Europe/Kyiv"), "2026-08-10");
});

test("nonexistent DST time moves forward to first representable minute", () => {
  const result = localDateAndTimeToUtc("2026-03-29", "03:30", "Europe/Kyiv");
  assert.equal(result.dstAdjusted, true);
  const local = localDateTimeAt(result.date, "Europe/Kyiv");
  assert.deepEqual({ hour: local.hour, minute: local.minute }, { hour: 4, minute: 0 });
});

test("date shifting is calendar based", () => {
  assert.equal(shiftLocalDate("2026-02-28", 1), "2026-03-01");
  assert.equal(shiftLocalDate("2026-03-01", -1), "2026-02-28");
});

test("ISO instant formatter uses the timezone offset for that instant", async () => {
  const { formatIsoInstantInTimezone } = await import("../../.core-dist/timezone.js");
  assert.equal(formatIsoInstantInTimezone(new Date("2026-08-09T15:00:00.000Z"), "Europe/Kyiv"), "2026-08-09T18:00:00+03:00");
});
