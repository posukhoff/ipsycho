import test from "node:test";
import assert from "node:assert/strict";
import { createTaskInputFromAction, InvalidAiActionError, rescheduleFieldsFromAction, seriesDefinitionFromAction } from "../../dist/actions/action-conversion.js";
import { AiTurnSchema } from "../../dist/ai/ai-contracts.js";

const definition = {
  kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv",
  plannedStartAt: null, plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null,
  fuzzyHorizonText: null, reviewAt: null, recurrenceRule: null, recurrenceTimezone: null,
  missPolicy: null, habitMode: false, minimumAction: null, desiredAction: null, habitTrigger: null,
};

const action = (overrides = {}) => ({
  type: "create_task", source: "user_explicit", confidence: 1, criticalExplicit: false, habitModeExplicit: false,
  title: "Тест", why: null, nextAction: null, context: null, checklist: null, goalLink: null,
  definition: { ...definition, ...overrides },
});

const scope = { workspaceId: "00000000-0000-4000-8000-000000000001", actorUserId: "00000000-0000-4000-8000-000000000002", recipientUserId: "00000000-0000-4000-8000-000000000002", now: new Date("2026-08-20T09:00:00Z") };

test("structured local schedule and bounded recurrence compile without provider-authored ISO or RRULE", () => {
  const result = createTaskInputFromAction(action({
    recurrenceTimezone: "Europe/Kyiv", missPolicy: "expire",
    localSchedule: { mode: "exact", timezone: "Europe/Kyiv", startDate: "2026-08-25", startTime: "09:30", endDate: null, endTime: null, dueDate: null, dueTime: null, durationMinutes: null, fuzzyHorizonText: null, reviewDate: null, reviewTime: null },
    recurrence: { frequency: "weekly", interval: 2, startsOn: "2026-08-25", endsOn: "2026-10-20", weekdays: ["TU"], monthDays: null, localTimes: null, excludedLocalDates: ["2026-09-08"] },
  }), scope);
  assert.equal(result.definition.plannedStartAt.toISOString(), "2026-08-25T06:30:00.000Z");
  assert.equal(result.definition.recurrenceRule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU");
  assert.equal(result.definition.recurrenceEndLocalDate, "2026-10-20");
  assert.deepEqual(result.definition.recurrenceExcludedLocalDates, ["2026-09-08"]);
});

test("legacy UTC and explicit-offset timestamps canonicalize to the same instant", () => {
  const utc = createTaskInputFromAction(action({ plannedStartAt: "2026-08-25T06:30:00Z" }), scope);
  const offset = createTaskInputFromAction(action({ plannedStartAt: "2026-08-25T09:30:00+03:00" }), scope);
  assert.equal(utc.definition.plannedStartAt.toISOString(), offset.definition.plannedStartAt.toISOString());
});

test("structured and legacy timing cannot conflict", () => {
  assert.throws(() => createTaskInputFromAction(action({
    plannedStartAt: "2026-08-25T06:30:00Z",
    localSchedule: { mode: "exact", timezone: "Europe/Kyiv", startDate: "2026-08-25", startTime: "10:00" },
  }), scope), InvalidAiActionError);
});

test("equivalent structured and legacy timing is canonicalized once", () => {
  const result = createTaskInputFromAction(action({
    plannedStartAt: "2026-08-25T06:30:00Z",
    localSchedule: { mode: "exact", timezone: "Europe/Kyiv", startDate: "2026-08-25", startTime: "09:30" },
  }), scope);
  assert.equal(result.definition.plannedStartAt.toISOString(), "2026-08-25T06:30:00.000Z");
});

test("structured contract rejects unsupported recurrence approximation fields", () => {
  const turn = { reply: "ok", question: null, topic: { mode: "none", topicId: null, title: null, summary: null }, topicModeSuggestion: null, actions: [action({
    localSchedule: { mode: "exact", timezone: "Europe/Kyiv", startDate: "2026-08-25", startTime: "09:30", endDate: null, endTime: null, dueDate: null, dueTime: null, durationMinutes: null, fuzzyHorizonText: null, reviewDate: null, reviewTime: null },
    recurrence: { frequency: "monthly", interval: 1, startsOn: "2026-08-25", endsOn: null, weekdays: null, monthDays: [25], localTimes: null, excludedLocalDates: null, bySetPos: 1 },
  })] };
  assert.equal(AiTurnSchema.safeParse(turn).success, false);
});

test("reschedule and series edit use the same local schedule compiler", () => {
  const localSchedule = { mode: "exact", timezone: "Europe/Kyiv", startDate: "2026-09-01", startTime: "09:30" };
  const rescheduled = rescheduleFieldsFromAction({
    type: "reschedule_occurrence", source: "user_explicit", confidence: 1,
    occurrenceId: "00000000-0000-4000-8000-000000000003", expectedVersion: 1, reason: null,
    schedule: { timezone: "Europe/Kyiv", plannedStartAt: null, plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null, fuzzyHorizonText: null, reviewAt: null, localSchedule },
  });
  assert.equal(rescheduled.plannedStartAt.toISOString(), "2026-09-01T06:30:00.000Z");

  const current = { ...createTaskInputFromAction(action({ plannedStartAt: "2026-08-25T06:30:00Z", recurrenceRule: "FREQ=WEEKLY", recurrenceTimezone: "Europe/Kyiv", missPolicy: "expire" }), scope).definition };
  const edited = seriesDefinitionFromAction({
    type: "change_series", source: "user_explicit", confidence: 1,
    taskId: "00000000-0000-4000-8000-000000000004", expectedVersion: 1, operation: "edit",
    edit: {
      timezone: "Europe/Kyiv", recurrenceTimezone: "Europe/Kyiv", missPolicy: "expire",
      plannedStartAt: null, plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null, recurrenceRule: null,
      localSchedule,
      recurrence: { frequency: "weekly", interval: 2, startsOn: "2026-09-01", endsOn: "2026-10-27", weekdays: ["TU"], monthDays: null, localTimes: null, excludedLocalDates: ["2026-09-15"] },
    },
  }, current);
  assert.equal(edited.recurrenceRule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU");
  assert.deepEqual(edited.recurrenceExcludedLocalDates, ["2026-09-15"]);
});

test("create_task carries an explicit reminder that replaces the default one", () => {
  // Production 2026-08-23: "напомни за полчаса" produced a task with only the default 18:00 reminder.
  const exact = { mode: "exact", timezone: "Europe/Kyiv", startDate: "2026-08-23", startTime: "18:00", endDate: null, endTime: null, dueDate: null, dueTime: null, durationMinutes: null, fuzzyHorizonText: null, reviewDate: null, reviewTime: null };
  const reminder = { triggerKind: "relative_timestamp", exactAt: null, anchor: "planned_start", offsetMinutes: -30, daysOffset: null, localTime: null, quietPolicy: "respect" };
  const result = createTaskInputFromAction({ ...action({ localSchedule: exact }), reminder }, scope);
  assert.deepEqual(result.explicitReminder, { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -1800, purpose: "user_reminder", quietPolicy: "respect", origin: "explicit" });

  assert.equal(createTaskInputFromAction({ ...action({ localSchedule: exact }), reminder: null }, scope).explicitReminder, undefined);
  assert.equal(createTaskInputFromAction(action({ localSchedule: exact }), scope).explicitReminder, undefined);

  const deadline = { ...exact, mode: "deadline", startDate: null, startTime: null, dueDate: "2026-08-30", dueTime: null };
  assert.throws(
    () => createTaskInputFromAction({ ...action({ timeMode: "deadline", localSchedule: deadline }), reminder: { ...reminder, anchor: "due_at" } }, scope),
    (error) => error instanceof InvalidAiActionError && /has no exact time/.test(error.message),
  );
  assert.throws(
    () => createTaskInputFromAction({ ...action({ localSchedule: exact }), reminder: { ...reminder, quietPolicy: "bypass" } }, scope),
    (error) => error instanceof InvalidAiActionError && /bypass must be explicit/.test(error.message),
  );
  const parsed = AiTurnSchema.parse({
    reply: "ok", question: null, topic: { mode: "none", topicId: null, title: null, summary: null }, topicModeSuggestion: null,
    actions: [{ ...action({ localSchedule: exact }), reminder }],
  });
  assert.equal(parsed.actions[0].reminder.offsetMinutes, -30);
  assert.equal(parsed.actions[0].quietBypassExplicit, false);
  const stored = AiTurnSchema.parse({
    reply: "ok", question: null, topic: { mode: "none", topicId: null, title: null, summary: null }, topicModeSuggestion: null,
    actions: [action({ localSchedule: exact })],
  });
  assert.equal(stored.actions[0].reminder, null);
});

test("weekly recurrence accepts the time its own schedule anchor carries, and a coarser legacy echo of that date", () => {
  const result = createTaskInputFromAction(action({
    recurrenceTimezone: "Europe/Kyiv", missPolicy: "carry_over",
    plannedLocalDate: "2026-08-30",
    localSchedule: { mode: "exact", timezone: "Europe/Kyiv", startDate: "2026-08-30", startTime: "14:00", endDate: null, endTime: null, dueDate: null, dueTime: null, durationMinutes: null, fuzzyHorizonText: null, reviewDate: null, reviewTime: null },
    recurrence: { frequency: "weekly", interval: 1, startsOn: "2026-08-30", endsOn: null, weekdays: ["SU"], monthDays: null, localTimes: ["14:00"], excludedLocalDates: null },
  }), scope);
  assert.equal(result.definition.recurrenceRule, "FREQ=WEEKLY;INTERVAL=1;BYDAY=SU");
  assert.equal(result.definition.plannedStartAt.toISOString(), "2026-08-30T11:00:00.000Z");
  assert.equal(result.definition.plannedLocalDate, undefined);
});

test("a legacy date naming a different day than the structured schedule still conflicts", () => {
  assert.throws(() => createTaskInputFromAction(action({
    plannedLocalDate: "2026-08-31",
    localSchedule: { mode: "exact", timezone: "Europe/Kyiv", startDate: "2026-08-30", startTime: "14:00", endDate: null, endTime: null, dueDate: null, dueTime: null, durationMinutes: null, fuzzyHorizonText: null, reviewDate: null, reviewTime: null },
  }), scope), InvalidAiActionError);
});

test("a weekly recurrence time that contradicts its schedule start is rejected", () => {
  assert.throws(() => createTaskInputFromAction(action({
    recurrenceTimezone: "Europe/Kyiv", missPolicy: "carry_over",
    localSchedule: { mode: "exact", timezone: "Europe/Kyiv", startDate: "2026-08-30", startTime: "14:00", endDate: null, endTime: null, dueDate: null, dueTime: null, durationMinutes: null, fuzzyHorizonText: null, reviewDate: null, reviewTime: null },
    recurrence: { frequency: "weekly", interval: 1, startsOn: "2026-08-30", endsOn: null, weekdays: ["SU"], monthDays: null, localTimes: ["09:00"], excludedLocalDates: null },
  }), scope), /contradicts the schedule start time 14:00/);
});
