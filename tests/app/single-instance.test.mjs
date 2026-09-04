import test from "node:test";
import assert from "node:assert/strict";
import { SingleInstanceService } from "../../dist/runtime/single-instance.service.js";

function fakeClient(responses) {
  const listeners = {};
  return {
    listeners,
    queries: [],
    async connect() {},
    async end() {},
    on(event, listener) { listeners[event] = listener; },
    async query(sql, params) {
      this.queries.push(sql);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { rows: [next] };
    },
  };
}

function build(client) {
  const service = Object.create(SingleInstanceService.prototype);
  let lost = null;
  Object.assign(service, { client, locked: false, onLost: (reason) => { lost = reason; } });
  return { service, lostReason: () => lost };
}

test("boot acquires the lock and a later check that finds it held keeps the process alive", async () => {
  const client = fakeClient([{ locked: true }, { held: true }]);
  const { service, lostReason } = build(client);
  await service.onModuleInit();
  assert.equal(await service.verifyLock(), true);
  assert.equal(lostReason(), null);
  await service.onApplicationShutdown();
  assert.match(client.queries.at(-1), /pg_advisory_unlock/);
});

test("a second instance refuses to start", async () => {
  const { service } = build(fakeClient([{ locked: false }]));
  await assert.rejects(() => service.onModuleInit(), /already active/);
});

test("losing the lock or the lock connection ends the process instead of running twice", async () => {
  const dropped = fakeClient([{ locked: true }, { held: false }]);
  const first = build(dropped);
  await first.service.onModuleInit();
  assert.equal(await first.service.verifyLock(), false);
  assert.equal(first.lostReason(), "lock no longer held by this session");

  const broken = fakeClient([{ locked: true }]);
  const second = build(broken);
  await second.service.onModuleInit();
  broken.listeners.error(new Error("terminating connection due to administrator command"));
  assert.equal(second.lostReason(), "connection error");
  await second.service.onApplicationShutdown();
});

test("a transient failure of the check itself is not treated as a lost lock", async () => {
  const client = fakeClient([{ locked: true }, new Error("timeout")]);
  const { service, lostReason } = build(client);
  await service.onModuleInit();
  assert.equal(await service.verifyLock(), true);
  assert.equal(lostReason(), null);
  await service.onApplicationShutdown();
});
