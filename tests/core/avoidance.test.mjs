import test from "node:test";
import assert from "node:assert/strict";
import { assessAvoidance, deriveAvoidanceSignals } from "../../.core-dist/avoidance.js";

test("single friction signal is not yet labelled avoidance", () => {
  assert.deepEqual(assessAvoidance({ reschedules: 1, seenWithoutStart: 0, ignoredStartChecks: 0 }), { detected: false, reasons: [] });
});

test("repeated reschedule or seen detects avoidance pattern", () => {
  assert.deepEqual(assessAvoidance({ reschedules: 2, seenWithoutStart: 2, ignoredStartChecks: 0 }), {
    detected: true,
    reasons: ["repeated_reschedule", "repeated_seen"],
  });
});

test("starting resets pending Seen/start-check friction", async () => {
  assert.deepEqual(deriveAvoidanceSignals(["occurrence:seen", "occurrence:seen", "occurrence:in_progress", "occurrence:seen"]), {
    reschedules: 0,
    seenWithoutStart: 1,
    ignoredStartChecks: 0,
  });
});

test("ignored result checks contribute to avoidance only after repetition", () => {
  const once = assessAvoidance(deriveAvoidanceSignals(["occurrence:result_check_ignored"]));
  assert.equal(once.detected, false);
  const twice = assessAvoidance(deriveAvoidanceSignals(["occurrence:result_check_ignored", "occurrence:result_check_ignored"]));
  assert.equal(twice.detected, true);
  assert.ok(twice.reasons.includes("ignored_start_checks"));
});
