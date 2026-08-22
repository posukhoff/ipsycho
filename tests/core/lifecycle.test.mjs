import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOccurrenceLifecycle } from "../../.core-dist/lifecycle.js";

const base = {
  kind: "task",
  timeMode: "point",
  recurring: false,
  status: "open",
  timezone: "Europe/Kyiv",
  now: new Date("2026-08-10T10:00:00Z"),
  overdue: false,
  eventElapseGraceMinutes: 15,
};

test("scheduled occurrence opens when planned start arrives", () => {
  assert.deepEqual(evaluateOccurrenceLifecycle({ ...base, status: "scheduled", plannedStartAt: new Date("2026-08-10T09:59:00Z") }), { transitionTo: "open" });
});

test("event becomes elapsed after boundary plus grace", () => {
  assert.deepEqual(evaluateOccurrenceLifecycle({
    ...base,
    kind: "event",
    status: "open",
    plannedStartAt: new Date("2026-08-10T09:00:00Z"),
    now: new Date("2026-08-10T09:16:00Z"),
  }), { transitionTo: "elapsed" });
});

test("recurring expire policy skips unfinished occurrence", () => {
  assert.deepEqual(evaluateOccurrenceLifecycle({
    ...base,
    recurring: true,
    missPolicy: "expire",
    status: "in_progress",
    expiresAt: new Date("2026-08-10T09:00:00Z"),
  }), { transitionTo: "skipped" });
});

test("exact deadline becomes overdue without terminal transition", () => {
  assert.deepEqual(evaluateOccurrenceLifecycle({
    ...base,
    timeMode: "deadline",
    dueAt: new Date("2026-08-10T09:00:00Z"),
  }), { markOverdue: true });
});

test("date-only deadline becomes overdue only on following local date", () => {
  assert.deepEqual(evaluateOccurrenceLifecycle({
    ...base,
    timeMode: "deadline",
    dueLocalDate: "2026-08-10",
    now: new Date("2026-08-10T20:59:00Z"), // 23:59 Kyiv
  }), {});
  assert.deepEqual(evaluateOccurrenceLifecycle({
    ...base,
    timeMode: "deadline",
    dueLocalDate: "2026-08-10",
    now: new Date("2026-08-10T21:01:00Z"), // 00:01 next local day
  }), { markOverdue: true });
});

test("scheduled recurrence without planned start opens on its recurrence date", () => {
  assert.deepEqual(evaluateOccurrenceLifecycle({
    ...base,
    recurring: true,
    timeMode: "deadline",
    status: "scheduled",
    recurrenceKey: "2026-08-10",
  }), { transitionTo: "open" });
});
