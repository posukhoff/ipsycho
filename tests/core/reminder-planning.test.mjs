import test from "node:test";
import assert from "node:assert/strict";
import { defaultReminderTemplates } from "../../.core-dist/reminder-defaults.js";
import { buildOneTimeOccurrence } from "../../.core-dist/recurrence.js";
import { applyNotificationPolicy, defaultRuleSpecs, IMMEDIATE_DELIVERY_GRACE_MS, planReminders } from "../../.core-dist/reminder-planning.js";

const settings = {
  notificationTimezone: "Europe/Kyiv",
  quietHours: { enabled: true, weekday: { start: "22:00", end: "08:00" }, weekend: { start: "23:00", end: "09:00" } },
  morningReferenceTime: "09:00",
  eveningReferenceTime: "20:00",
};

test("event default reminders resolve against planned start", () => {
  const task = {
    kind: "event",
    importance: "normal",
    timeMode: "point",
    timezone: "Europe/Kyiv",
    plannedStartAt: new Date("2026-08-10T12:00:00Z"),
  };
  const occurrence = buildOneTimeOccurrence(task, new Date("2026-08-09T10:00:00Z"));
  const templates = defaultReminderTemplates({ kind: task.kind, timeMode: task.timeMode, importance: task.importance, hasPlannedStart: true });
  const rules = defaultRuleSpecs(task, templates, settings);
  const plans = planReminders({ task, occurrence, rules, settings, now: new Date("2026-08-09T10:00:00Z") });
  assert.deepEqual(plans.map((x) => x.intendedFor.toISOString()), [
    "2026-08-10T11:00:00.000Z",
    "2026-08-10T11:45:00.000Z",
  ]);
});

test("event reminders at the event start are not scheduled", () => {
  const task = {
    kind: "event",
    importance: "normal",
    timeMode: "point",
    timezone: "Europe/Kyiv",
    plannedStartAt: new Date("2026-08-10T12:00:00Z"),
  };
  const occurrence = buildOneTimeOccurrence(task, new Date("2026-08-09T10:00:00Z"));
  const rules = [
    { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -15 * 60, purpose: "user_reminder", quietPolicy: "respect" },
    { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: 0, purpose: "user_reminder", quietPolicy: "respect" },
  ];
  const plans = planReminders({ task, occurrence, rules, settings, now: new Date("2026-08-09T10:00:00Z") });
  assert.deepEqual(plans.map((x) => x.intendedFor.toISOString()), ["2026-08-10T11:45:00.000Z"]);
});

test("date-only required deadline uses evening/morning reference times", () => {
  const task = {
    kind: "task",
    importance: "required",
    timeMode: "deadline",
    timezone: "Europe/Kyiv",
    dueLocalDate: "2026-08-11",
  };
  const occurrence = buildOneTimeOccurrence(task, new Date("2026-08-09T10:00:00Z"));
  const templates = defaultReminderTemplates({ kind: task.kind, timeMode: task.timeMode, importance: task.importance, hasPlannedStart: false });
  const rules = defaultRuleSpecs(task, templates, settings);
  const plans = planReminders({ task, occurrence, rules, settings, now: new Date("2026-08-09T10:00:00Z") });
  assert.deepEqual(plans.map((x) => x.intendedFor.toISOString()), [
    "2026-08-10T17:00:00.000Z",
    "2026-08-11T06:00:00.000Z",
    "2026-08-11T17:00:00.000Z",
  ]);
});

test("quiet hours defer a task reminder, but never past the task itself", () => {
  const task = {
    kind: "task",
    importance: "normal",
    timeMode: "point",
    timezone: "Europe/Kyiv",
    plannedStartAt: new Date("2026-08-10T20:30:00Z"), // Monday 23:30, inside quiet hours
  };
  const occurrence = buildOneTimeOccurrence(task, new Date("2026-08-09T10:00:00Z"));
  const atStart = [{ triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: 0, purpose: "user_reminder", quietPolicy: "respect" }];
  const [plan] = planReminders({ task, occurrence, rules: atStart, settings, now: new Date("2026-08-09T10:00:00Z") });
  // Production 2026-08-22: a 23:00 task got its reminder the next morning at 09:00. The user chose 23:30, so it fires then.
  assert.equal(plan.scheduledFor.toISOString(), "2026-08-10T20:30:00.000Z");
  assert.equal(plan.suppressedReason, undefined);

  const before = [{ triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -30 * 60, purpose: "user_reminder", quietPolicy: "respect" }];
  const [early] = planReminders({ task, occurrence, rules: before, settings, now: new Date("2026-08-09T10:00:00Z") });
  assert.equal(early.scheduledFor.toISOString(), "2026-08-10T20:30:00.000Z");

  // A reminder the evening before a morning task still waits for quiet hours to end: that is before the task.
  const morningTask = { ...task, plannedStartAt: new Date("2026-08-11T07:00:00Z") }; // Tuesday 10:00
  const morningOccurrence = buildOneTimeOccurrence(morningTask, new Date("2026-08-09T10:00:00Z"));
  const eveningBefore = [{ triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -11 * 60 * 60, purpose: "user_reminder", quietPolicy: "respect" }]; // 23:00 Monday
  const [deferred] = planReminders({ task: morningTask, occurrence: morningOccurrence, rules: eveningBefore, settings, now: new Date("2026-08-09T10:00:00Z") });
  assert.equal(deferred.scheduledFor.toISOString(), "2026-08-11T05:00:00.000Z");
});

test("event reminder deferred beyond event becomes quiet_stale", () => {
  const task = {
    kind: "event",
    importance: "normal",
    timeMode: "point",
    timezone: "Europe/Kyiv",
    plannedStartAt: new Date("2026-08-10T20:30:00Z"),
  };
  const occurrence = buildOneTimeOccurrence(task, new Date("2026-08-09T10:00:00Z"));
  const rules = [{ triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -15 * 60, purpose: "user_reminder", quietPolicy: "respect" }];
  const [plan] = planReminders({ task, occurrence, rules, settings, now: new Date("2026-08-09T10:00:00Z") });
  assert.equal(plan.suppressedReason, "quiet_stale");
});

test("contacts closer than 15 minutes collapse to later contact", () => {
  const task = {
    kind: "task",
    importance: "critical",
    timeMode: "deadline",
    timezone: "Europe/Kyiv",
    dueAt: new Date("2026-08-10T10:05:00Z"),
    plannedStartAt: new Date("2026-08-10T10:00:00Z"),
  };
  const occurrence = buildOneTimeOccurrence(task, new Date("2026-08-09T10:00:00Z"));
  const rules = [
    { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: 0, purpose: "user_reminder", quietPolicy: "respect" },
    { triggerKind: "relative_timestamp", anchor: "due_at", offsetSeconds: 0, purpose: "user_reminder", quietPolicy: "respect" },
  ];
  const plans = planReminders({ task, occurrence, rules, settings, now: new Date("2026-08-09T10:00:00Z") });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].intendedFor.toISOString(), "2026-08-10T10:05:00.000Z");
});

test("snooze delays even a quiet-hours bypass reminder", () => {
  const task = {
    kind: "task",
    importance: "required",
    timeMode: "point",
    timezone: "Europe/Kyiv",
    plannedStartAt: new Date("2026-08-10T20:30:00Z"),
  };
  const occurrence = buildOneTimeOccurrence(task, new Date("2026-08-09T10:00:00Z"));
  const snoozedSettings = { ...settings, notificationsSnoozedUntil: new Date("2026-08-11T06:00:00Z") };
  const rules = [{ triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: 0, purpose: "user_reminder", quietPolicy: "bypass" }];
  const [plan] = planReminders({ task, occurrence, rules, settings: snoozedSettings, now: new Date("2026-08-09T10:00:00Z") });
  assert.equal(plan.scheduledFor.toISOString(), "2026-08-11T06:00:00.000Z");
});

test("a reminder only milliseconds behind during rebuild is sent immediately", () => {
  const intendedFor = new Date("2026-08-11T18:22:38.000Z");
  const task = { kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv", plannedStartAt: intendedFor };
  const occurrence = buildOneTimeOccurrence(task, new Date("2026-08-11T18:00:00Z"));
  const rule = { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: 0, purpose: "user_reminder", quietPolicy: "bypass" };
  const policy = applyNotificationPolicy({
    intendedFor,
    now: new Date(intendedFor.getTime() + 500),
    task,
    occurrence,
    rule,
    settings: { ...settings, quietHours: { ...settings.quietHours, enabled: false } },
  });
  assert.equal(policy.suppressedReason, undefined);
  assert.equal(policy.scheduledFor.toISOString(), "2026-08-11T18:22:38.500Z");
});

test("a genuinely old reminder remains suppressed", () => {
  const intendedFor = new Date("2026-08-11T18:22:38.000Z");
  const task = { kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv", plannedStartAt: intendedFor };
  const occurrence = buildOneTimeOccurrence(task, new Date("2026-08-11T18:00:00Z"));
  const policy = applyNotificationPolicy({
    intendedFor,
    now: new Date(intendedFor.getTime() + IMMEDIATE_DELIVERY_GRACE_MS + 1),
    task,
    occurrence,
    rule: { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: 0, purpose: "user_reminder", quietPolicy: "bypass" },
    settings: { ...settings, quietHours: { ...settings.quietHours, enabled: false } },
  });
  assert.equal(policy.suppressedReason, "no_longer_applicable");
});
