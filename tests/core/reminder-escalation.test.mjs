import test from "node:test";
import assert from "node:assert/strict";
import { nextCriticalEscalationAt, reminderBriefingBundleDecision } from "../../.core-dist/reminder-escalation.js";

test("critical escalation respects configurable >=15 minute interval", () => {
  const sent = new Date("2026-08-09T17:00:00Z");
  assert.equal(nextCriticalEscalationAt(sent, 60).toISOString(), "2026-08-09T18:00:00.000Z");
  assert.throws(() => nextCriticalEscalationAt(sent, 14));
});

test("deadline reminder yields to a same-slot digest, but not forever", () => {
  const scheduled = new Date("2026-08-09T17:00:00Z");
  assert.equal(reminderBriefingBundleDecision({ reminderScheduledFor: scheduled, briefingScheduledFor: scheduled, briefingStatus: "sent", now: scheduled }), "suppress");
  assert.equal(reminderBriefingBundleDecision({ reminderScheduledFor: scheduled, briefingScheduledFor: scheduled, briefingStatus: "pending", now: new Date("2026-08-09T17:02:00Z") }), "wait");
  assert.equal(reminderBriefingBundleDecision({ reminderScheduledFor: scheduled, briefingScheduledFor: scheduled, briefingStatus: "pending", now: new Date("2026-08-09T17:06:00Z") }), "none");
  assert.equal(reminderBriefingBundleDecision({ reminderScheduledFor: scheduled, briefingScheduledFor: new Date("2026-08-09T17:10:00Z"), briefingStatus: "sent", now: scheduled }), "none");
});
