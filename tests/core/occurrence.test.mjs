import test from "node:test";
import assert from "node:assert/strict";
import { deriveInitialOccurrenceStatus, validateOccurrenceTransition } from "../../.core-dist/occurrence.js";

const now = new Date("2026-08-09T12:00:00Z");
const ctx = { kind: "task", recurring: false, now, eventElapseGraceMinutes: 15, explicitUserAction: true, systemExpire: false };

test("future occurrence starts scheduled", () => assert.equal(deriveInitialOccurrenceStatus(now, new Date("2026-08-09T13:00:00Z")), "scheduled"));
test("current occurrence starts open", () => assert.equal(deriveInitialOccurrenceStatus(now, new Date("2026-08-09T11:00:00Z")), "open"));
test("one-time task cannot be skipped", () => assert.equal(validateOccurrenceTransition("open", "skipped", ctx).ok, false));
test("recurring task may be explicitly skipped", () => assert.equal(validateOccurrenceTransition("open", "skipped", { ...ctx, recurring: true }).ok, true));
test("task cannot become elapsed", () => assert.equal(validateOccurrenceTransition("open", "elapsed", ctx).ok, false));
test("event becomes elapsed only after grace", () => {
  const event = { ...ctx, kind: "event", plannedStartAt: new Date("2026-08-09T11:30:00Z") };
  assert.equal(validateOccurrenceTransition("open", "elapsed", event).ok, true);
  assert.equal(validateOccurrenceTransition("open", "elapsed", { ...event, now: new Date("2026-08-09T11:40:00Z") }).ok, false);
});
test("elapsed event may be completed late", () => assert.equal(validateOccurrenceTransition("elapsed", "done", { ...ctx, kind: "event" }).ok, true));
