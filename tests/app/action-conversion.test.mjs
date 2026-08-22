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
