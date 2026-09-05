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
    definition: { kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv", plannedStartAt: new Date(now.getTime() + 20 * 60_000) },
    explicitReminder: { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -1200, purpose: "user_reminder", quietPolicy: "respect", origin: "explicit" },
  });
  const { rows } = await database.pool.query("select id, scheduled_for from reminder_deliveries where task_id=$1", [result.taskId]);
  assert.equal(rows.length, 1);
  return { deliveryId: rows[0].id, scheduledFor: new Date(rows[0].scheduled_for), taskId: result.taskId };
}

async function scheduledFor(id) {
  const { rows } = await database.pool.query("select scheduled_for, intended_for from reminder_deliveries where id=$1", [id]);
  return rows[0];
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

test("quiet hours turned on after scheduling push a future reminder to the end of the quiet window", async () => {
  const context = await fixture();
  const { deliveryId, taskId } = await dueDelivery(context);
  // The task itself is far away, so the quiet-hours deferral is not capped by the task boundary.
  const tomorrowNoon = new Date(Date.now() + 36 * 60 * 60_000);
  await database.pool.query("update task_occurrences set planned_start_at=$2 where task_id=$1", [taskId, tomorrowNoon]);
  await database.pool.query("update tasks set planned_start_at=$2 where id=$1", [taskId, tomorrowNoon]).catch(() => undefined);
  // The reminder is still ahead of us, and the user has just declared the whole day quiet.
  await database.pool.query("update reminder_deliveries set intended_for = now() + interval '10 minutes', scheduled_for = now() where id=$1", [deliveryId]);
  await database.pool.query(
    "update user_settings set quiet_hours_enabled=true, weekday_quiet_start='00:00', weekday_quiet_end='23:59', weekend_quiet_start='00:00', weekend_quiet_end='23:59' where user_id=$1",
    [context.userId],
  );

  const telegram = fakeTelegram();
  const service = await startQueueService(telegram);
  await service.reconcile();
  await waitFor(async () => {
    const row = await scheduledFor(deliveryId);
    return new Date(row.scheduled_for) > new Date(row.intended_for);
  });
  assert.equal(telegram.sent.length, 0, "a reminder inside quiet hours must not be sent yet");
  assert.equal((await deliveryRow(deliveryId)).status, "pending");
});

test("a reminder deferred by quiet hours is sent once the window opens, with the deferral notice", async () => {
  const context = await fixture();
  const { deliveryId, taskId } = await dueDelivery(context);
  // The task itself is far away, so the quiet-hours deferral is not capped by the task boundary.
  await database.pool.query("update task_occurrences set planned_start_at=$2 where task_id=$1", [taskId, new Date(Date.now() + 36 * 60 * 60_000)]);
  await database.pool.query("update tasks set planned_start_at=$2 where id=$1", [taskId, new Date(Date.now() + 36 * 60 * 60_000)]);
  // A quiet window that ended this very minute: the reminder was meant for the middle of it.
  const local = (at) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  const quietStart = local(new Date(Date.now() - 3 * 60 * 60_000));
  const quietEnd = local(new Date());
  await database.pool.query(
    "update user_settings set quiet_hours_enabled=true, weekday_quiet_start=$2, weekday_quiet_end=$3, weekend_quiet_start=$2, weekend_quiet_end=$3 where user_id=$1",
    [context.userId, quietStart, quietEnd],
  );
  await database.pool.query("update reminder_deliveries set intended_for = now() - interval '2 hours', scheduled_for = now() where id=$1", [deliveryId]);

  const telegram = fakeTelegram();
  const service = await startQueueService(telegram);
  await service.reconcile();
  await waitFor(async () => (await deliveryRow(deliveryId)).status === "sent");
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0].text, /quiet hours/);
});

test("a delivery that already failed once is not discarded as stale on the retry", async () => {
  const context = await fixture();
  const { deliveryId } = await dueDelivery(context);
  // One attempt spent by the transport, and more than the 60-second staleness grace gone with it.
  await database.pool.query("update reminder_deliveries set attempts = 1, intended_for = now() - interval '2 minutes', scheduled_for = now() - interval '2 minutes' where id=$1", [
    deliveryId,
  ]);
  const telegram = fakeTelegram();
  const service = await startQueueService(telegram);
  await service.reconcile();
  await waitFor(async () => (await deliveryRow(deliveryId)).status === "sent");
  assert.equal(telegram.sent.length, 1, "that time was spent by the transport, not by the user");

  // A first attempt that arrives equally late is still suppressed: nothing has tried to send it.
  const untouched = await fixture();
  const fresh = await dueDelivery(untouched);
  await database.pool.query("update reminder_deliveries set intended_for = now() - interval '2 minutes', scheduled_for = now() - interval '2 minutes' where id=$1", [
    fresh.deliveryId,
  ]);
  await service.reconcile();
  await waitFor(async () => (await deliveryRow(fresh.deliveryId)).status === "suppressed");
  assert.equal((await deliveryRow(fresh.deliveryId)).suppressed_reason, "no_longer_applicable");
});

test("a delivery whose occurrence was completed in the meantime is suppressed, not sent", async () => {
  const context = await fixture();
  const { deliveryId, taskId } = await dueDelivery(context);
  await database.pool.query("update task_occurrences set status='done' where task_id=$1", [taskId]);

  const telegram = fakeTelegram();
  await startQueueService(telegram);
  await waitFor(async () => (await deliveryRow(deliveryId)).status === "suppressed");
  assert.equal(telegram.sent.length, 0);
  assert.equal((await deliveryRow(deliveryId)).suppressed_reason, "no_longer_applicable");
});

test("a delivery for a suspended account is suppressed as an access decision", async () => {
  const context = await fixture();
  const { deliveryId } = await dueDelivery(context);
  await database.pool.query("update users set status='disabled' where id=$1", [context.userId]);

  const telegram = fakeTelegram();
  await startQueueService(telegram);
  await waitFor(async () => (await deliveryRow(deliveryId)).status === "suppressed");
  assert.equal(telegram.sent.length, 0);
  assert.equal((await deliveryRow(deliveryId)).suppressed_reason, "access");
});

test("the queue summary counts what is waiting, what is late and what could not be confirmed", async () => {
  const context = await fixture();
  const { deliveryId } = await dueDelivery(context);
  const service = await startQueueService(fakeTelegram());
  await database.pool.query("update reminder_deliveries set status='pending', scheduled_for = now() - interval '30 minutes' where id=$1", [deliveryId]);
  const late = await service.queueSummary();
  assert.equal(late.pending, 1);
  assert.equal(late.stalePending, 1);

  await database.pool.query("update reminder_deliveries set status='ambiguous' where id=$1", [deliveryId]);
  const ambiguous = await service.queueSummary();
  assert.equal(ambiguous.pending, 0);
  assert.equal(ambiguous.stalePending, 0);
  assert.equal(ambiguous.ambiguous, 1);
});
