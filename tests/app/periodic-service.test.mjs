import test from "node:test";
import assert from "node:assert/strict";
import { PeriodicService } from "../../dist/runtime/periodic.service.js";
import { loopHealth } from "../../dist/observability/loop-health.js";

class Probe extends PeriodicService {
  loopName = "probe";
  intervalMs = 60_000;
  ticks = 0;
  gate = null;
  fail = false;
  async runTick() {
    this.ticks += 1;
    if (this.gate) await this.gate;
    if (this.fail) throw new Error("tick exploded");
  }
}

test("a tick that is still running is not started again, and a failing tick does not kill the loop", async () => {
  loopHealth.reset();
  const probe = new Probe();
  let release;
  probe.gate = new Promise((resolve) => (release = resolve));
  const first = probe.tick();
  assert.equal(await probe.tick(), false, "overlapping tick must be skipped");
  release();
  assert.equal(await first, true);
  assert.equal(probe.ticks, 1);

  probe.gate = null;
  probe.fail = true;
  assert.equal(await probe.tick(), false);
  probe.fail = false;
  assert.equal(await probe.tick(), true);
  assert.equal(probe.ticks, 3);
  loopHealth.reset();
});

test("bootstrap registers the loop, runs one tick and reports liveness", async () => {
  loopHealth.reset();
  const probe = new Probe();
  await probe.onApplicationBootstrap();
  probe.onApplicationShutdown();
  assert.equal(probe.ticks, 1);
  const [status] = loopHealth.snapshot();
  assert.equal(status.name, "probe");
  assert.equal(status.stale, false);
  assert.ok(status.lastTickAt);
  loopHealth.reset();
});

test("a loop whose first tick throws is still registered, so /ready sees it go stale", async () => {
  loopHealth.reset();
  const probe = new Probe();
  probe.fail = true;
  await probe.onApplicationBootstrap();
  probe.onApplicationShutdown();
  const [status] = loopHealth.snapshot();
  assert.equal(status.lastTickAt, null);
  assert.deepEqual(loopHealth.staleLoops(Date.now() + 4 * 60_000), ["probe"]);
  loopHealth.reset();
});
