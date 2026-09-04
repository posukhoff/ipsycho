import test from "node:test";
import assert from "node:assert/strict";
import { isRescheduleReasonRequired, validateNewTaskTiming, validateOneTimeTaskTiming, validateTaskDefinition, taskCreatesOccurrence } from "../../.core-dist/task-policy.js";

const base = { kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv", plannedStartAt: new Date("2026-08-10T09:00:00Z") };

test("point task is valid", () => assert.deepEqual(validateTaskDefinition(base), { ok: true }));
test("event cannot be deadline", () => assert.equal(validateTaskDefinition({ ...base, kind: "event", timeMode: "deadline", dueAt: new Date() }).ok, false));
test("critical date-only deadline is rejected", () =>
  assert.equal(validateTaskDefinition({ ...base, importance: "critical", timeMode: "deadline", plannedStartAt: undefined, dueLocalDate: "2026-08-11" }).ok, false));
test("fuzzy task requires reviewAt", () =>
  assert.equal(validateTaskDefinition({ ...base, timeMode: "fuzzy", plannedStartAt: undefined, fuzzyHorizonText: "на следующей неделе" }).ok, false));
test("fuzzy task does not create occurrence", () =>
  assert.equal(taskCreatesOccurrence({ ...base, timeMode: "fuzzy", plannedStartAt: undefined, fuzzyHorizonText: "к осени", reviewAt: new Date() }), false));
test("habit requires recurring task and minimum/desired actions", () =>
  assert.equal(validateTaskDefinition({ ...base, recurrenceRule: "FREQ=DAILY", recurrenceTimezone: "Europe/Kyiv", missPolicy: "expire", habitMode: true }).ok, false));

test("unsupported recurrence frequency is rejected", () =>
  assert.equal(validateTaskDefinition({ ...base, recurrenceRule: "FREQ=YEARLY", recurrenceTimezone: "Europe/Kyiv", missPolicy: "carry_over" }).ok, false));
test("miss policy without recurrence is rejected", () => assert.equal(validateTaskDefinition({ ...base, missPolicy: "carry_over" }).ok, false));
test("recurrence bounds and exclusions require a valid series", () => {
  assert.equal(validateTaskDefinition({ ...base, recurrenceEndLocalDate: "2026-09-30" }).ok, false);
  assert.equal(
    validateTaskDefinition({
      ...base,
      recurrenceRule: "FREQ=DAILY",
      recurrenceTimezone: "Europe/Kyiv",
      missPolicy: "carry_over",
      recurrenceEndLocalDate: "2026-08-09",
    }).ok,
    false,
  );
  assert.equal(
    validateTaskDefinition({
      ...base,
      recurrenceRule: "FREQ=DAILY",
      recurrenceTimezone: "Europe/Kyiv",
      missPolicy: "carry_over",
      recurrenceEndLocalDate: "2026-09-30",
      recurrenceExcludedLocalDates: ["2026-08-12"],
    }).ok,
    true,
  );
});
test("point cannot secretly contain deadline", () => assert.equal(validateTaskDefinition({ ...base, dueAt: new Date("2026-08-11T09:00:00Z") }).ok, false));
test("fuzzy cannot contain concrete start", () =>
  assert.equal(validateTaskDefinition({ ...base, timeMode: "fuzzy", fuzzyHorizonText: "в течение месяца", reviewAt: new Date() }).ok, false));
test("unsupported recurrence fields are rejected", () =>
  assert.equal(validateTaskDefinition({ ...base, recurrenceRule: "FREQ=DAILY;COUNT=4", recurrenceTimezone: "Europe/Kyiv", missPolicy: "carry_over" }).ok, false));
test("multiple daily times require an exact point or window start", () => {
  const invalid = validateTaskDefinition({
    ...base,
    timeMode: "deadline",
    plannedStartAt: undefined,
    dueAt: new Date("2026-08-12T09:00:00Z"),
    recurrenceRule: "FREQ=DAILY;BYTIME=09:00,18:00",
    recurrenceTimezone: "Europe/Kyiv",
    missPolicy: "expire",
  });
  assert.deepEqual(invalid, { ok: false, errors: ["BYTIME requires a point or window recurrence with plannedStartAt"] });
});
test("multiple daily times include the series start time", () => {
  const invalid = validateTaskDefinition({
    ...base,
    recurrenceRule: "FREQ=DAILY;BYTIME=09:00,18:00",
    recurrenceTimezone: "Europe/Kyiv",
    missPolicy: "expire",
  });
  assert.deepEqual(invalid, { ok: false, errors: ["plannedStartAt time must be included in BYTIME"] });
});
test("deadline planned start cannot be after exact due", () =>
  assert.equal(validateTaskDefinition({ ...base, timeMode: "deadline", plannedStartAt: new Date("2026-08-11T10:00:00Z"), dueAt: new Date("2026-08-11T09:00:00Z") }).ok, false));

test("one-time tasks cannot be created with a past boundary", () => {
  const now = new Date("2026-08-11T17:30:00Z");
  assert.match(validateNewTaskTiming({ ...base, plannedStartAt: new Date("2026-08-11T17:29:59Z") }, now).join(" "), /plannedStartAt/);
  assert.deepEqual(validateNewTaskTiming({ ...base, plannedStartAt: new Date("2026-08-11T17:32:00Z") }, now), []);
});

test("a new recurring series cannot start in the past", () => {
  const now = new Date("2026-08-11T17:30:00Z");
  const errors = validateNewTaskTiming(
    {
      ...base,
      plannedStartAt: new Date("2026-08-11T17:29:59Z"),
      recurrenceRule: "FREQ=DAILY;BYTIME=20:00",
      recurrenceTimezone: "Europe/Kyiv",
      missPolicy: "expire",
    },
    now,
  );
  assert.match(errors.join(" "), /plannedStartAt.*recurring task/);
});

test("the same temporal guard protects a one-time reschedule", () => {
  const now = new Date("2026-08-11T17:30:00Z");
  const errors = validateOneTimeTaskTiming({ ...base, plannedStartAt: new Date("2026-08-11T17:29:59Z") }, now, "rescheduling a one-time task");
  assert.match(errors.join(" "), /rescheduling a one-time task/);
});

test("temporal guard covers every concrete one-time boundary in the user timezone", () => {
  const now = new Date("2026-08-11T17:30:00Z"); // 20:30 in Kyiv
  const futureStart = new Date("2026-08-11T17:31:00Z");
  for (const [field, value] of [
    ["plannedEndAt", new Date("2026-08-11T17:29:59Z")],
    ["dueAt", new Date("2026-08-11T17:29:59Z")],
    ["reviewAt", new Date("2026-08-11T17:29:59Z")],
    ["plannedLocalDate", "2026-08-10"],
    ["dueLocalDate", "2026-08-10"],
  ]) {
    const errors = validateOneTimeTaskTiming({ ...base, plannedStartAt: futureStart, [field]: value }, now, "testing");
    assert.match(errors.join(" "), new RegExp(field));
  }
});

test("reschedule reason is required by importance or repeated normal reschedule", () => {
  assert.equal(isRescheduleReasonRequired("normal", 0), false);
  assert.equal(isRescheduleReasonRequired("normal", 1), true);
  assert.equal(isRescheduleReasonRequired("required", 0), true);
  assert.equal(isRescheduleReasonRequired("critical", 0), true);
});
