import test from "node:test";
import assert from "node:assert/strict";
import { defaultReminderTemplates, shouldMergeReminderContacts } from "../../.core-dist/reminder-defaults.js";

test("event gets 1h and 15m reminders", () => {
  assert.deepEqual(
    defaultReminderTemplates({ kind: "event", timeMode: "point", importance: "normal", hasPlannedStart: true }).map((x) => x.offsetMinutes),
    [-60, -15],
  );
});
test("ordinary exact task gets exact start reminder", () => {
  assert.deepEqual(defaultReminderTemplates({ kind: "task", timeMode: "point", importance: "normal", hasPlannedStart: true }), [
    { kind: "relative", anchor: "planned_start", offsetMinutes: 0 },
  ]);
});
test("required deadline gets evening before, morning of and evening decision", () => {
  assert.deepEqual(defaultReminderTemplates({ kind: "task", timeMode: "deadline", importance: "required", hasPlannedStart: false }), [
    { kind: "local_date", anchor: "due_at", daysOffset: -1, reference: "evening" },
    { kind: "local_date", anchor: "due_at", daysOffset: 0, reference: "morning" },
    { kind: "local_date", anchor: "due_at", daysOffset: 0, reference: "evening", purpose: "follow_up" },
  ]);
});
test("critical deadline includes post-due follow-up", () => {
  assert.deepEqual(
    defaultReminderTemplates({ kind: "task", timeMode: "deadline", importance: "critical", hasPlannedStart: false }).map((x) => x.offsetMinutes),
    [-180, -60, -30, -15, 0, 60],
  );
});
test("contacts closer than 15 minutes merge", () => {
  const a = new Date("2026-08-10T10:00:00Z");
  assert.equal(shouldMergeReminderContacts(a, new Date("2026-08-10T10:14:59Z")), true);
  assert.equal(shouldMergeReminderContacts(a, new Date("2026-08-10T10:15:00Z")), false);
});

test("Seen fallback depends only on importance", () => {});
