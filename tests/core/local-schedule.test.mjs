import test from "node:test";
import assert from "node:assert/strict";
import { compileStructuredLocalSchedule } from "../../.core-dist/local-schedule.js";

test("local schedules compile exact, date-only, deadline and fuzzy modes", () => {
  assert.equal(compileStructuredLocalSchedule({ mode: "exact", timezone: "Europe/Kyiv", startDate: "2026-08-25", startTime: "09:30" }).plannedStartAt.toISOString(), "2026-08-25T06:30:00.000Z");
  assert.deepEqual(compileStructuredLocalSchedule({ mode: "date", timezone: "Europe/Kyiv", startDate: "2026-08-25" }), { timeMode: "point", timezone: "Europe/Kyiv", plannedLocalDate: "2026-08-25" });
  assert.deepEqual(compileStructuredLocalSchedule({ mode: "deadline", timezone: "Europe/Kyiv", dueDate: "2026-08-25" }), { timeMode: "deadline", timezone: "Europe/Kyiv", dueLocalDate: "2026-08-25" });
  assert.equal(compileStructuredLocalSchedule({ mode: "fuzzy", timezone: "Europe/Kyiv", fuzzyHorizonText: "на следующей неделе", reviewDate: "2026-08-24", reviewTime: "18:00" }).reviewAt.toISOString(), "2026-08-24T15:00:00.000Z");
});

test("window schedules preserve durations and cross midnight", () => {
  const duration = compileStructuredLocalSchedule({ mode: "window", timezone: "Europe/Kyiv", startDate: "2026-08-25", startTime: "23:30", durationMinutes: 90 });
  assert.equal(duration.plannedEndAt.toISOString(), "2026-08-25T22:00:00.000Z");
  const overnight = compileStructuredLocalSchedule({ mode: "window", timezone: "Europe/Kyiv", startDate: "2026-08-25", startTime: "23:30", endTime: "01:00" });
  assert.equal(overnight.plannedEndAt.toISOString(), "2026-08-25T22:00:00.000Z");
});

test("Kyiv DST mapping is deterministic and mode fields cannot conflict", () => {
  assert.equal(compileStructuredLocalSchedule({ mode: "exact", timezone: "Europe/Kyiv", startDate: "2026-03-29", startTime: "03:30" }).plannedStartAt.toISOString(), "2026-03-29T01:00:00.000Z");
  assert.throws(() => compileStructuredLocalSchedule({ mode: "exact", timezone: "Europe/Kyiv", startDate: "2026-08-25", startTime: "09:30", dueDate: "2026-08-26" }), /dueDate/);
  assert.throws(() => compileStructuredLocalSchedule({ mode: "window", timezone: "Europe/Kyiv", startDate: "2026-08-25", startTime: "09:30", endTime: "10:00", durationMinutes: 30 }), /not both/);
});
