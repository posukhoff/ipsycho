import test from "node:test";
import assert from "node:assert/strict";
import { HealthController } from "../../dist/health.controller.js";
import { MaintenanceService } from "../../dist/maintenance/maintenance.service.js";
import { loopHealth } from "../../dist/observability/loop-health.js";

function fakeDatabase(delayMs = 0) {
  return { db: { execute: () => new Promise((resolve) => setTimeout(() => resolve([]), delayMs)) } };
}

test("/health never touches the database; /ready fails on a stale loop and on a slow database", async () => {
  loopHealth.reset();
  loopHealth.register("probe", 1000, 0);
  const controller = new HealthController(fakeDatabase(), { appCommit: "abc" });
  assert.deepEqual(controller.health(), { status: "ok", commit: "abc" });
  await assert.rejects(
    () => controller.ready(),
    (error) => error.getResponse().staleLoops.includes("probe"),
  );
  loopHealth.beat("probe");
  const body = await controller.ready();
  assert.equal(body.status, "ok");
  assert.equal(body.database, "ok");

  const slow = new HealthController(fakeDatabase(3000), { appCommit: "abc" });
  await assert.rejects(
    () => slow.ready(),
    (error) => error.getResponse().database === "timeout",
  );
  loopHealth.reset();
});

test("queue problems reach the owner once per change, never repeatedly", async () => {
  const sent = [];
  const summary = { pending: 3, stalePending: 2, ambiguous: 0, deadLettered: 1 };
  const service = new MaintenanceService(
    { ownerTelegramUserId: 42 },
    { db: {} },
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    { queueSummary: async () => summary },
    {},
    { sendMessage: async (id, text) => void sent.push({ id, text }) },
  );
  await service.alertOwnerOnQueueProblems(new Date());
  await service.alertOwnerOnQueueProblems(new Date());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 42);
  assert.match(sent[0].text, /pending>10min=2 dead_letter=1/);
  summary.deadLettered = 0;
  await service.alertOwnerOnQueueProblems(new Date());
  assert.equal(sent.length, 2);
  assert.doesNotMatch(sent[1].text, /dead_letter/);
  summary.stalePending = 0;
  await service.alertOwnerOnQueueProblems(new Date());
  assert.equal(sent.length, 2);
});
