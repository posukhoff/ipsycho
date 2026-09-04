import test from "node:test";
import assert from "node:assert/strict";
import { estimateAiCostUsd } from "../../.core-dist/ai-usage-policy.js";

const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.1, revision: "r" };

test("cached prompt tokens are billed at the cached price, the rest at the input price", () => {
  assert.equal(estimateAiCostUsd(1_000_000, 0, pricing), 1);
  assert.equal(estimateAiCostUsd(1_000_000, 0, pricing, 400_000), 0.64);
  assert.equal(estimateAiCostUsd(1_000_000, 250_000, pricing, 1_000_000), 1.1);
});

test("without a cached price the cache does not change the estimate; a cache larger than the input is clamped", () => {
  const plain = { inputUsdPerMillion: 1, outputUsdPerMillion: 4, revision: "r" };
  assert.equal(estimateAiCostUsd(1_000_000, 0, plain, 500_000), 1);
  assert.equal(estimateAiCostUsd(100, 0, pricing, 5_000), 0.00001);
  assert.equal(estimateAiCostUsd(undefined, 1, pricing), undefined);
});
