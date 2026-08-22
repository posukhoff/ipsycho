import test from "node:test";
import assert from "node:assert/strict";
import { voiceWithinLimits } from "../../.core-dist/voice-policy.js";
import { estimateAudioCostUsd } from "../../.core-dist/ai-usage-policy.js";

test("voice limits accept the boundary and reject oversize input", () => {
  assert.equal(voiceWithinLimits({ durationSeconds: 300, bytes: 20 * 1024 * 1024, maxDurationSeconds: 300, maxBytes: 20 * 1024 * 1024 }), true);
  assert.equal(voiceWithinLimits({ durationSeconds: 301, bytes: 1, maxDurationSeconds: 300, maxBytes: 20 * 1024 * 1024 }), false);
  assert.equal(voiceWithinLimits({ durationSeconds: 1, bytes: 20 * 1024 * 1024 + 1, maxDurationSeconds: 300, maxBytes: 20 * 1024 * 1024 }), false);
});

test("audio cost uses configured per-minute pricing", () => {
  assert.equal(estimateAudioCostUsd(90, { audioUsdPerMinute: 0.01, revision: "voice-r1" }), 0.015);
  assert.equal(estimateAudioCostUsd(90, { revision: "missing" }), undefined);
});

test("voice limits reject invalid metadata instead of accepting a zero-duration recording", () => {
  assert.equal(voiceWithinLimits({ durationSeconds: 0, bytes: 10, maxDurationSeconds: 300, maxBytes: 20 * 1024 * 1024 }), false);
  assert.equal(voiceWithinLimits({ durationSeconds: 1, bytes: -1, maxDurationSeconds: 300, maxBytes: 20 * 1024 * 1024 }), false);
});
