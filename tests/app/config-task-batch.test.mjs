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

test("APP_COMMIT is exposed only when the image actually carries a commit", () => {
  assert.equal(loadConfig(base).appCommit, undefined);
  assert.equal(loadConfig({ ...base, APP_COMMIT: "unknown" }).appCommit, undefined);
  assert.equal(loadConfig({ ...base, APP_COMMIT: "ddaba510e6feb22f67f3130d16501a039284a73d" }).appCommit, "ddaba510e6feb22f67f3130d16501a039284a73d");
});
