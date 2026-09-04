import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GrammyError, HttpError } from "grammy";
import { DatabaseService } from "../../dist/database/database.service.js";
import { JobQueueService } from "../../dist/queue/job-queue.service.js";
import { ReminderQueueService, REMINDER_QUEUE } from "../../dist/reminders/reminder-queue.service.js";
import { TasksRepository } from "../../dist/tasks/tasks.repository.js";
import { TasksService } from "../../dist/tasks/tasks.service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required; run npm run test:e2e");

const database = new DatabaseService({ databaseUrl: url });
const jobs = new JobQueueService({ databaseUrl: url });

/** Records every send; `failures` is a FIFO of errors to throw before the first success. */
function fakeTelegram() {
  const sent = [];
  const failures = [];
  return {
    sent,
    failures,
    async sendReminder(telegramUserId, text, occurrenceId, status) {
      const failure = failures.shift();
      if (failure) throw failure;
      sent.push({ telegramUserId, text, occurrenceId, status });
      return 1000 + sent.length;
    },
  };
}

// Every test boots its own ReminderQueueService, and each boot registers one more worker on the
// shared queue. Whichever worker picks a job must talk to the fake of the running test.
const telegramProxy = {
  current: fakeTelegram(),
  sendReminder: (...args) => telegramProxy.current.sendReminder(...args),
};

let telegramUserSequence = Date.now();

async function fixture() {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  telegramUserSequence += 1;
  await database.pool.query("insert into users(id, telegram_user_id) values ($1, $2)", [userId, BigInt(telegramUserSequence)]);
  await database.pool.query("insert into workspaces(id, owner_user_id) values ($1, $2)", [workspaceId, userId]);
  await database.pool.query("insert into workspace_members(workspace_id, user_id, role) values ($1, $2, 'owner')", [workspaceId, userId]);
  await database.pool.query("insert into user_settings(user_id, quiet_hours_enabled) values ($1, false)", [userId]);
  return { workspaceId, userId };
}

/** A task whose one explicit reminder is due right now. */
async function dueDelivery({ workspaceId, userId }) {
  const now = new Date();
  const tasksService = new TasksService(new TasksRepository(database), { enqueue: async () => undefined }, {});
  const result = await tasksService.createTask({
    workspaceId,
    actorUserId: userId,
    recipientUserId: userId,
    title: "Позвонить врачу",
    now,
    definition: { kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv", plannedStartAt: new Date(now.getTime() + 20 * 60_000), habitMode: false },
    explicitReminder: { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -1200, purpose: "user_reminder", quietPolicy: "respect", origin: "explicit" },
  });
  const { rows } = await database.pool.query("select id, scheduled_for from reminder_deliveries where task_id=$1", [result.taskId]);
  assert.equal(rows.length, 1);
  return { deliveryId: rows[0].id, scheduledFor: new Date(rows[0].scheduled_for), taskId: result.taskId };
}

async function deliveryRow(id) {
  const { rows } = await database.pool.query("select status, attempts, suppressed_reason, sent_at from reminder_deliveries where id=$1", [id]);
  return rows[0];
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("condition not met in time");
}

const services = [];

async function startQueueService(telegram) {
  telegramProxy.current = telegram;
  const service = new ReminderQueueService(database, telegramProxy, jobs);
  await service.onApplicationBootstrap();
  services.push(service);
  return service;
}

before(async () => {
  await jobs.onModuleInit();
});

beforeEach(async () => {
  await database.pool.query("truncate table users cascade");
  await database.pool.query("delete from pgboss.job where name like 'reminder-delivery%'").catch(() => undefined);
});

after(async () => {
  for (const service of services) service.onApplicationShutdown();
  await jobs.onApplicationShutdown();
  await database.onApplicationShutdown();
});

test("the queue is created under the short policy so a singleton key deduplicates jobs", async () => {
  const telegram = fakeTelegram();
  await startQueueService(telegram);
  const { rows } = await database.pool.query("select policy, dead_letter from pgboss.queue where name=$1", [REMINDER_QUEUE]);
  assert.equal(rows[0]?.policy, "short");
  assert.equal(rows[0]?.dead_letter, `${REMINDER_QUEUE}-dead`);

  const startAfter = new Date(Date.now() + 60 * 60_000);
  const first = await jobs.send(REMINDER_QUEUE, { deliveryId: randomUUID() }, { startAfter, singletonKey: "dedupe-key" });
  const second = await jobs.send(REMINDER_QUEUE, { deliveryId: randomUUID() }, { startAfter, singletonKey: "dedupe-key" });
  assert.ok(first);
  assert.equal(second, null);
});

test("a delivery left in processing by a crashed process is sent exactly once after boot", async () => {
  const context = await fixture();
  const { deliveryId } = await dueDelivery(context);
  await database.pool.query("update reminder_deliveries set status='processing', attempts=1 where id=$1", [deliveryId]);

  const telegram = fakeTelegram();
  await startQueueService(telegram);
  await waitFor(async () => (await deliveryRow(deliveryId)).status === "sent");
  // Give any duplicate job time to fire before asserting.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(telegram.sent.length, 1);
  assert.equal((await deliveryRow(deliveryId)).attempts, 2);
});

test("a delivery whose owner rows are gone is suppressed as orphaned instead of retried forever", async () => {
  const context = await fixture();
  const { deliveryId } = await dueDelivery(context);
  await database.pool.query("delete from user_settings where user_id=$1", [context.userId]);

  const telegram = fakeTelegram();
  await startQueueService(telegram);
  await waitFor(async () => (await deliveryRow(deliveryId)).status === "suppressed");
  assert.equal((await deliveryRow(deliveryId)).suppressed_reason, "orphaned");
  assert.equal(telegram.sent.length, 0);
});

test("a 429 from Telegram is retried after retry_after without spending an attempt", async () => {
  const context = await fixture();
  const { deliveryId } = await dueDelivery(context);
  const telegram = fakeTelegram();
  telegram.failures.push(
    new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }, "sendMessage", {}),
  );

  await startQueueService(telegram);
  await waitFor(async () => (await deliveryRow(deliveryId)).status === "sent");
  const row = await deliveryRow(deliveryId);
  assert.equal(row.attempts, 1);
  assert.equal(telegram.sent.length, 1);
});

test("a permanent Telegram rejection marks the delivery failed without retrying", async () => {
  const context = await fixture();
  const { deliveryId } = await dueDelivery(context);
  const telegram = fakeTelegram();
  telegram.failures.push(
    new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, "sendMessage", {}),
  );

  await startQueueService(telegram);
  await waitFor(async () => (await deliveryRow(deliveryId)).status === "failed");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(telegram.sent.length, 0);
  assert.equal((await deliveryRow(deliveryId)).attempts, 1);
});

test("a timeout after the request left the process is recorded as ambiguous and never resent", async () => {
  const context = await fixture();
  const { deliveryId } = await dueDelivery(context);
  const telegram = fakeTelegram();
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  telegram.failures.push(new HttpError("Network request for 'sendMessage' failed!", abort));

  await startQueueService(telegram);
  await waitFor(async () => (await deliveryRow(deliveryId)).status === "ambiguous");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(telegram.sent.length, 0);
  assert.ok((await deliveryRow(deliveryId)).sent_at);
});

test("a connection refused before anything was sent is retried and eventually delivered", async () => {
  const context = await fixture();
  const { deliveryId } = await dueDelivery(context);
  const telegram = fakeTelegram();
  const refused = new TypeError("fetch failed");
  refused.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  telegram.failures.push(new HttpError("Network request for 'sendMessage' failed!", refused));

  const service = await startQueueService(telegram);
  await waitFor(async () => (await deliveryRow(deliveryId)).status === "pending" && (await deliveryRow(deliveryId)).attempts === 1);
  // pg-boss retries with a 30 s delay; the reconciler re-enqueues the pending row sooner under a new key.
  await service.reconcile();
  await waitFor(async () => (await deliveryRow(deliveryId)).status === "sent");
  assert.equal(telegram.sent.length, 1);
  assert.equal((await deliveryRow(deliveryId)).attempts, 2);
});
