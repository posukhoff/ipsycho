import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../dist/config.js";

const base = { DATABASE_URL: "postgresql://test", AI_MODEL: "test-model" };

test("task batches are disabled by default", () => {
  assert.equal(loadConfig(base).taskBatchEnabled, false);
});

test("task batch rollout flag accepts explicit true and false", () => {
  assert.equal(loadConfig({ ...base, TASK_BATCH_ENABLED: "true" }).taskBatchEnabled, true);
  assert.equal(loadConfig({ ...base, TASK_BATCH_ENABLED: "false" }).taskBatchEnabled, false);
});
