import test from "node:test";
import assert from "node:assert/strict";
import { briefingStillUseful } from "../../.core-dist/digest-policy.js";
import { estimateAiCostUsd, aiBurstAllowed, shouldWarnMonthlySpend } from "../../.core-dist/ai-usage-policy.js";
import { seriesOperationState } from "../../.core-dist/series-policy.js";

test("a briefing is never replayed on another local date", () => {
  assert.equal(briefingStillUseful("2026-08-09", "2026-08-09"), true);
  assert.equal(briefingStillUseful("2026-08-09", "2026-08-10"), false);
});

test("AI usage policies calculate and gate without floats accumulating in domain state", () => {
  assert.equal(estimateAiCostUsd(1_000_000, 1_000_000, { inputUsdPerMillion: 1, outputUsdPerMillion: 6, revision: "r1" }), 7);
  assert.equal(aiBurstAllowed({ messagesLastHour: 39, callsLastHour: 39, maxMessagesPerHour: 40, maxCallsPerHour: 40 }), true);
  assert.equal(aiBurstAllowed({ messagesLastHour: 40, callsLastHour: 1, maxMessagesPerHour: 40, maxCallsPerHour: 40 }), false);
  assert.equal(shouldWarnMonthlySpend({ totalUsd: 5, thresholdUsd: 5, alreadyWarnedThisMonth: false }), true);
});

test("series operations keep current occurrence unless cancelling", () => {
  assert.deepEqual(seriesOperationState("pause", true), { parentStatus: "paused", currentOccurrenceAction: "keep", deleteUntouchedFuture: true, rematerializeFuture: false });
  assert.equal(seriesOperationState("cancel", true).currentOccurrenceAction, "cancel");
});
