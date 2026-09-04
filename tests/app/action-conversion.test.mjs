import test from "node:test";
import assert from "node:assert/strict";
import {
  compileWhen,
  createTaskInputFromBody,
  InvalidAiActionError,
  reminderRuleFromReminder,
  rescheduleFieldsFromWhen,
  seriesDefinitionFromReschedule,
  taskDefinitionFromBody,
  validateUpdateTaskPatch,
  whenFromRescheduleFields,
} from "../../dist/actions/action-conversion.js";

const ctx = { timezone: "Europe/Kyiv", reviewTime: "09:00" };
const now = new Date("2026-08-20T09:00:00Z");
const scope = { workspaceId: "00000000-0000-4000-8000-000000000001", actorUserId: "00000000-0000-4000-8000-000000000002", recipientUserId: "00000000-0000-4000-8000-000000000002", now };

const exact = { mode: "exact", date: "2026-08-25", time: "09:30", durationMinutes: null };
const body = (overrides = {}) => ({
  title: "Тест", why: null, nextAction: null, context: null, checklist: null,
  importance: "normal", kind: "task", when: exact, recurrence: null, reminder: null, habit: null, timezone: null,
  ...overrides,
});
const weekly = { frequency: "weekly", interval: 2, weekdays: ["MO"], monthDays: null, until: null, skipDates: null, missed: null };

const withCode = (code) => (error) => error instanceof InvalidAiActionError && error.code === code;

test("a date without a clock time compiles to an all-day window", () => {
  const definition = taskDefinitionFromBody(body({ when: { mode: "date", date: "2026-08-25" } }), ctx, now);
  assert.equal(definition.timeMode, "window");
  assert.equal(definition.plannedLocalDate, "2026-08-25");
  assert.equal(definition.plannedStartAt, undefined);
  assert.equal(definition.timezone, "Europe/Kyiv");
});

test("exact with durationMinutes compiles to a window with an end", () => {
  const definition = taskDefinitionFromBody(body({ when: { ...exact, durationMinutes: 90 }, kind: "event" }), ctx, now);
  assert.equal(definition.timeMode, "window");
  assert.equal(definition.plannedStartAt.toISOString(), "2026-08-25T06:30:00.000Z");
  assert.equal(definition.plannedEndAt.toISOString(), "2026-08-25T08:00:00.000Z");
  assert.equal(taskDefinitionFromBody(body(), ctx, now).timeMode, "point");
});

test("deadline compiles with or without a clock time", () => {
  const timed = taskDefinitionFromBody(body({ when: { mode: "deadline", date: "2026-08-30", time: "18:00" } }), ctx, now);
  assert.equal(timed.timeMode, "deadline");
  assert.equal(timed.dueAt.toISOString(), "2026-08-30T15:00:00.000Z");
  assert.equal(timed.dueLocalDate, undefined);
  const dateOnly = taskDefinitionFromBody(body({ when: { mode: "deadline", date: "2026-08-30", time: null } }), ctx, now);
  assert.equal(dateOnly.timeMode, "deadline");
  assert.equal(dateOnly.dueLocalDate, "2026-08-30");
  assert.equal(dateOnly.dueAt, undefined);
});

test("fuzzy takes its review clock time from the schedule context, never from the model", () => {
  const definition = taskDefinitionFromBody(body({ when: { mode: "fuzzy", horizonText: "к осени", reviewDate: "2026-09-01" } }), ctx, now);
  assert.equal(definition.timeMode, "fuzzy");
  assert.equal(definition.fuzzyHorizonText, "к осени");
  assert.equal(definition.reviewAt.toISOString(), "2026-09-01T06:00:00.000Z");
  const later = taskDefinitionFromBody(body({ when: { mode: "fuzzy", horizonText: "к осени", reviewDate: "2026-09-01" } }), { ...ctx, reviewTime: "20:30" }, now);
  assert.equal(later.reviewAt.toISOString(), "2026-09-01T17:30:00.000Z");
});

test("weekly recurrence derives startsOn and its clock time from when, never from localTimes", () => {
  const definition = taskDefinitionFromBody(body({ when: { ...exact, date: "2026-08-24" }, recurrence: { ...weekly, until: "2026-10-19", skipDates: ["2026-09-07"] } }), ctx, now);
  assert.equal(definition.recurrenceRule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
  assert.equal(definition.recurrenceTimezone, "Europe/Kyiv");
  assert.equal(definition.plannedStartAt.toISOString(), "2026-08-24T06:30:00.000Z");
  assert.equal(definition.recurrenceEndLocalDate, "2026-10-19");
  assert.deepEqual(definition.recurrenceExcludedLocalDates, ["2026-09-07"]);
  assert.doesNotMatch(definition.recurrenceRule, /BYHOUR|BYMINUTE/);
});

test("missed defaults to carry_over for deadlines and expire for exact times", () => {
  const daily = { ...weekly, frequency: "daily", interval: 1, weekdays: null };
  const deadline = taskDefinitionFromBody(body({ when: { mode: "deadline", date: "2026-08-25", time: "18:00" }, recurrence: daily }), ctx, now);
  assert.equal(deadline.missPolicy, "carry_over");
  const point = taskDefinitionFromBody(body({ recurrence: daily }), ctx, now);
  assert.equal(point.missPolicy, "expire");
  const chosen = taskDefinitionFromBody(body({ recurrence: { ...daily, missed: "carry_over" } }), ctx, now);
  assert.equal(chosen.missPolicy, "carry_over");
  assert.equal("missPolicy" in taskDefinitionFromBody(body(), ctx, now), false);
});

test("a recurring task cannot use a fuzzy horizon", () => {
  assert.throws(
    () => taskDefinitionFromBody(body({ when: { mode: "fuzzy", horizonText: "к осени", reviewDate: "2026-09-01" }, recurrence: weekly }), ctx, now),
    withCode("recurring_fuzzy"),
  );
});

test("a time already in the past is rejected with time_past", () => {
  assert.throws(() => taskDefinitionFromBody(body({ when: { ...exact, date: "2026-08-01" } }), ctx, now), withCode("time_past"));
  assert.throws(() => taskDefinitionFromBody(body({ when: { mode: "deadline", date: "2026-08-01", time: null } }), ctx, now), withCode("time_past"));
});

test("an explicit reminder on a fuzzy task is rejected with fuzzy_reminder", () => {
  const reminder = { kind: "offset", anchor: "start", minutes: -30, quiet: "respect" };
  assert.throws(
    () => createTaskInputFromBody(body({ when: { mode: "fuzzy", horizonText: "к осени", reviewDate: "2026-09-01" }, reminder }), scope, ctx),
    withCode("fuzzy_reminder"),
  );
  assert.throws(
    () => createTaskInputFromBody(body({ when: { mode: "deadline", date: "2026-08-30", time: null }, reminder: { ...reminder, anchor: "due" } }), scope, ctx),
    withCode("date_only_offset"),
  );
  const input = createTaskInputFromBody(body({ reminder }), scope, ctx);
  assert.deepEqual(input.explicitReminder, { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -1800, purpose: "user_reminder", quietPolicy: "respect", origin: "explicit" });
  assert.equal(createTaskInputFromBody(body(), scope, ctx).explicitReminder, undefined);
});

test("reminderRuleFromReminder maps at, offset and day reminders", () => {
  assert.deepEqual(reminderRuleFromReminder({ kind: "at", date: "2026-08-25", time: "08:00", quiet: "bypass" }, "Europe/Kyiv"), {
    triggerKind: "exact", exactAt: new Date("2026-08-25T05:00:00.000Z"), purpose: "user_reminder", quietPolicy: "bypass", origin: "explicit",
  });
  assert.deepEqual(reminderRuleFromReminder({ kind: "offset", anchor: "due", minutes: -120, quiet: "respect" }, "Europe/Kyiv"), {
    triggerKind: "relative_timestamp", anchor: "due_at", offsetSeconds: -7200, purpose: "user_reminder", quietPolicy: "respect", origin: "explicit",
  });
  assert.equal(reminderRuleFromReminder({ kind: "offset", anchor: "end", minutes: 5, quiet: "respect" }, "Europe/Kyiv").anchor, "planned_end");
  assert.deepEqual(reminderRuleFromReminder({ kind: "day", anchor: "due", daysOffset: -1, time: "19:00", quiet: "respect" }, "Europe/Kyiv"), {
    triggerKind: "local_date", anchor: "due_at", daysOffset: -1, localTime: "19:00", purpose: "user_reminder", quietPolicy: "respect", origin: "explicit",
  });
  assert.equal(reminderRuleFromReminder({ kind: "day", anchor: "start", daysOffset: 0, time: "07:00", quiet: "respect" }, "Europe/Kyiv").anchor, "planned_start");
});

test("validateUpdateTaskPatch rejects an empty patch and blank fields", () => {
  const empty = { title: null, why: null, nextAction: null, context: null, checklist: null, importance: null, habit: null };
  assert.throws(() => validateUpdateTaskPatch(empty), withCode("empty_patch"));
  assert.throws(() => validateUpdateTaskPatch({ ...empty, title: "   " }), withCode("blank_field"));
  assert.throws(() => validateUpdateTaskPatch({ ...empty, checklist: [{ text: "a", done: false }, { text: "A", done: false }] }), withCode("checklist"));
  assert.doesNotThrow(() => validateUpdateTaskPatch({ ...empty, importance: "required" }));
  assert.doesNotThrow(() => validateUpdateTaskPatch({ ...empty, habit: { enabled: false } }));
});

test("whenFromRescheduleFields round-trips every When mode", () => {
  const whens = [
    exact,
    { ...exact, durationMinutes: 45 },
    { mode: "date", date: "2026-08-25" },
    { mode: "deadline", date: "2026-08-30", time: "18:00" },
    { mode: "deadline", date: "2026-08-30", time: null },
    { mode: "fuzzy", horizonText: "к осени", reviewDate: "2026-09-01" },
  ];
  for (const when of whens) {
    const { fields } = rescheduleFieldsFromWhen(when, ctx);
    assert.deepEqual(whenFromRescheduleFields(fields, ctx.timezone), when, JSON.stringify(when));
  }
  assert.equal(rescheduleFieldsFromWhen({ mode: "date", date: "2026-08-25" }, ctx).timeMode, "window");
  assert.equal(rescheduleFieldsFromWhen(exact, ctx).timeMode, "point");
  assert.throws(() => whenFromRescheduleFields({}, ctx.timezone), withCode("schedule"));
});

test("seriesDefinitionFromReschedule keeps the current rule when recurrence is null and rejects a time-mode change", () => {
  const current = taskDefinitionFromBody(body({ when: { ...exact, date: "2026-08-24" }, recurrence: { ...weekly, skipDates: ["2026-09-07"] } }), ctx, now);
  const action = (when, recurrence = null) => ({
    type: "reschedule", intent: "explicit", timezone: "Europe/Kyiv", reviewTime: "09:00",
    target: { kind: "series", taskId: "00000000-0000-4000-8000-000000000004", taskVersion: 1 },
    when, recurrence, reason: null,
  });
  const moved = seriesDefinitionFromReschedule(action({ ...exact, date: "2026-08-31", time: "11:00" }), current);
  assert.equal(moved.recurrenceRule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
  assert.deepEqual(moved.recurrenceExcludedLocalDates, ["2026-09-07"]);
  assert.equal(moved.plannedStartAt.toISOString(), "2026-08-31T08:00:00.000Z");
  assert.equal(moved.missPolicy, "expire");

  const rewritten = seriesDefinitionFromReschedule(action({ ...exact, date: "2026-08-26", time: "11:00" }, { ...weekly, interval: 1, weekdays: ["WE", "FR"] }), current);
  assert.equal(rewritten.recurrenceRule, "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE,FR");
  assert.equal(rewritten.recurrenceExcludedLocalDates, undefined);

  assert.throws(() => seriesDefinitionFromReschedule(action({ mode: "deadline", date: "2026-08-31", time: "11:00" }), current), withCode("series_time_mode"));
  assert.throws(() => seriesDefinitionFromReschedule(action({ mode: "fuzzy", horizonText: "к осени", reviewDate: "2026-09-01" }), current), withCode("recurring_fuzzy"));
});

test("compileWhen rejects an unknown timezone with its own code", () => {
  assert.throws(() => compileWhen(exact, { ...ctx, timezone: "Mars/Olympus" }), withCode("timezone"));
});
