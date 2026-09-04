import test from "node:test";
import assert from "node:assert/strict";
import { LoopHealth } from "../../dist/observability/loop-health.js";

test("a loop that never ticked is stale only after three intervals since registration", () => {
  const health = new LoopHealth();
  health.register("maintenance", 60_000, 0);
  assert.deepEqual(health.staleLoops(170_000), []);
  assert.deepEqual(health.staleLoops(181_000), ["maintenance"]);
});

test("a beat resets the staleness clock", () => {
  const health = new LoopHealth();
  health.register("reminders", 60_000, 0);
  health.beat("reminders", 500_000);
  assert.deepEqual(health.staleLoops(600_000), []);
  const [loop] = health.snapshot(600_000);
  assert.equal(loop.lastTickAt, new Date(500_000).toISOString());
  assert.deepEqual(health.staleLoops(700_000), ["reminders"]);
});

test("registering twice keeps the first registration; beating an unknown loop throws", () => {
  const health = new LoopHealth();
  health.register("a", 1000, 0);
  health.register("a", 5000, 100);
  assert.equal(health.snapshot(0)[0].intervalMs, 1000);
  assert.throws(() => health.beat("b"), /not registered/);
});
