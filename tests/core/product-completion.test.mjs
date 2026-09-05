import test from "node:test";
import assert from "node:assert/strict";
import { morningDigestSections, briefingStillUseful } from "../../.core-dist/digest-policy.js";
import { habitOfferEligible } from "../../.core-dist/habit-policy.js";
import { estimateAiCostUsd, aiBurstAllowed, shouldWarnMonthlySpend } from "../../.core-dist/ai-usage-policy.js";
import { seriesOperationState } from "../../.core-dist/series-policy.js";

test("the morning digest separates priority from normal, and a briefing is never replayed on another day", () => {
  const items = [
    { id: "1", title: "n", importance: "normal", status: "open" },
    { id: "2", title: "r", importance: "required", status: "overdue" },
    { id: "3", title: "c", importance: "critical", status: "in_progress" },
  ];
  assert.deepEqual(
    morningDigestSections(items).priority.map((x) => x.id),
    ["2", "3"],
  );
  assert.equal(briefingStillUseful("weekly", "2026-08-09", "2026-08-09"), true);
  assert.equal(briefingStillUseful("morning", "2026-08-09", "2026-08-10"), false);
});

test("habit offer is at most once and only for recurring tasks", () => {
  assert.equal(habitOfferEligible({ recurring: true, kind: "task", alreadyHabit: false, offeredBefore: false, behavioral: true }), true);
  assert.equal(habitOfferEligible({ recurring: true, kind: "task", alreadyHabit: false, offeredBefore: true, behavioral: true }), false);
  assert.equal(habitOfferEligible({ recurring: true, kind: "event", alreadyHabit: false, offeredBefore: false, behavioral: true }), false);
});

test("AI usage policies calculate and gate without floats accumulating in domain state", () => {
  assert.equal(estimateAiCostUsd(1_000_000, 1_000_000, { inputUsdPerMillion: 1, outputUsdPerMillion: 6, revision: "r1" }), 7);
  assert.equal(aiBurstAllowed({ messagesLastHour: 39, callsLastHour: 39, maxMessagesPerHour: 40, maxCallsPerHour: 40 }), true);
  assert.equal(aiBurstAllowed({ messagesLastHour: 40, callsLastHour: 1, maxMessagesPerHour: 40, maxCallsPerHour: 40 }), false);
  assert.equal(shouldWarnMonthlySpend({ totalUsd: 5, thresholdUsd: 5, alreadyWarnedThisMonth: false }), true);
});

test("series operations keep current occurrence unless cancelling", () => {
  assert.deepEqual(seriesOperationState("pause", true), { parentStatus: "paused", currentOccurrenceAction: "keep", deleteUntouchedFuture: true, rematerializeFuture: false });
  assert.deepEqual(seriesOperationState("stop", true), { parentStatus: "active", currentOccurrenceAction: "keep", deleteUntouchedFuture: true, rematerializeFuture: false });
  assert.deepEqual(seriesOperationState("stop", false), { parentStatus: "closed", currentOccurrenceAction: "keep", deleteUntouchedFuture: true, rematerializeFuture: false });
  assert.equal(seriesOperationState("cancel", true).currentOccurrenceAction, "cancel");
});
