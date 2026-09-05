import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../dist/database/database.service.js";
import { MessagesRepository } from "../../dist/messages/messages.repository.js";
import { TasksRepository } from "../../dist/tasks/tasks.repository.js";
import { TasksService } from "../../dist/tasks/tasks.service.js";
import { ReminderSchedulingService } from "../../dist/reminders/reminder-scheduling.service.js";
import { AiRepository } from "../../dist/ai/ai.repository.js";
import { AccessService, DELETION_GRACE_DAYS } from "../../dist/access/access.service.js";
import { SettingsService } from "../../dist/settings/settings.service.js";
import { SettingsRepository } from "../../dist/settings/settings.repository.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required; run npm run test:e2e");

const database = new DatabaseService({ databaseUrl: url });
const tasksRepository = new TasksRepository(database);
const messagesRepository = new MessagesRepository(database);
let telegramUserSequence = Date.now();

async function fixture() {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  telegramUserSequence += 1;
  await database.pool.query("insert into users(id, telegram_user_id) values ($1, $2)", [userId, BigInt(telegramUserSequence)]);
  await database.pool.query("insert into workspaces(id, owner_user_id) values ($1, $2)", [workspaceId, userId]);
  await database.pool.query("insert into workspace_members(workspace_id, user_id, role) values ($1, $2, 'owner')", [workspaceId, userId]);
  await database.pool.query("insert into user_settings(user_id) values ($1)", [userId]);
  return { workspaceId, userId };
}

async function createTask({ workspaceId, userId }, title, startInMinutes = 60) {
  const now = new Date();
  const service = new TasksService(tasksRepository, { enqueue: async () => undefined }, {});
  return service.createTask({
    workspaceId,
    actorUserId: userId,
    recipientUserId: userId,
    title,
    now,
    definition: {
      kind: "task",
      importance: "normal",
      timeMode: "point",
      timezone: "Europe/Kyiv",
      plannedStartAt: new Date(now.getTime() + startInMinutes * 60_000),
    },
    explicitReminder: { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -600, purpose: "user_reminder", quietPolicy: "respect", origin: "explicit" },
  });
}

beforeEach(async () => {
  await database.pool.query("truncate table users cascade");
  await database.pool.query("delete from admin_audit_log");
});

after(async () => {
  await database.onApplicationShutdown();
});

test("retention cleanups run in bounded batches and report the total", async () => {
  const scope = await fixture();
  const old = new Date(Date.now() - 100 * 24 * 60 * 60_000);
  for (let index = 0; index < 25; index += 1) {
    await database.pool.query("insert into messages(workspace_id, user_id, role, content, status, created_at) values ($1, $2, 'user', $3, 'processed', $4)", [
      scope.workspaceId,
      scope.userId,
      `msg ${index}`,
      old,
    ]);
  }
  await database.pool.query("insert into messages(workspace_id, user_id, role, content, status) values ($1, $2, 'user', 'fresh', 'processed')", [scope.workspaceId, scope.userId]);
  assert.equal(await messagesRepository.deleteRawOlderThan(new Date(Date.now() - 90 * 24 * 60 * 60_000), 10), 25);
  const { rows } = await database.pool.query("select count(*)::int as count from messages");
  assert.equal(rows[0].count, 1);

  const { taskId } = await createTask(scope, "Старая");
  for (let index = 0; index < 12; index += 1) {
    await database.pool.query("insert into task_events(workspace_id, task_id, event_type, details, created_at) values ($1, $2, 'task:updated', 'x', $3)", [
      scope.workspaceId,
      taskId,
      old,
    ]);
  }
  assert.equal(await tasksRepository.clearEventDetailsOlderThan(new Date(), 5), 12);
  assert.equal(await tasksRepository.deleteEventsOlderThan(new Date(Date.now() - 365 * 24 * 60 * 60_000), 5), 0);
  await database.pool.query("update task_events set created_at = $1 where task_id = $2", [new Date(Date.now() - 400 * 24 * 60 * 60_000), taskId]);
  const remaining = await database.pool.query("select count(*)::int as count from task_events where task_id=$1", [taskId]);
  assert.equal(await tasksRepository.deleteEventsOlderThan(new Date(Date.now() - 365 * 24 * 60 * 60_000), 5), remaining.rows[0].count);
});

test("the snooze buttons on a reminder card schedule one system follow-up and supersede the previous one", async () => {
  // The 15-minute and one-hour buttons are the only reachable use of this path and it had no test,
  // so any change to the follow-up plumbing could take plain snooze with it unnoticed.
  const scope = await fixture();
  const { taskId } = await createTask(scope, "Позвонить в клинику");
  const { rows: occurrences } = await database.pool.query("select id from task_occurrences where task_id=$1", [taskId]);
  const occurrenceId = occurrences[0].id;
  const enqueued = [];
  const scheduling = new ReminderSchedulingService(database, { enqueue: async (...args) => void enqueued.push(args) });
  const now = new Date();

  const first = await scheduling.scheduleFollowUpChoice({ workspaceId: scope.workspaceId, userId: scope.userId, occurrenceId, choice: "15m", now });
  assert.ok(first, "snooze must schedule a delivery");
  const afterFirst = await database.pool.query(
    "select r.purpose, r.origin, r.active, d.status, d.intended_for from reminder_rules r join reminder_deliveries d on d.reminder_rule_id = r.id where r.occurrence_id=$1 and r.origin='system'",
    [occurrenceId],
  );
  assert.equal(afterFirst.rowCount, 1);
  assert.equal(afterFirst.rows[0].purpose, "follow_up");
  assert.equal(afterFirst.rows[0].status, "pending");
  assert.equal(Math.round((new Date(afterFirst.rows[0].intended_for) - now) / 60_000), 15);
  assert.equal(enqueued.length, 1);

  const second = await scheduling.scheduleFollowUpChoice({ workspaceId: scope.workspaceId, userId: scope.userId, occurrenceId, choice: "1h", now });
  assert.ok(second);
  const rules = await database.pool.query("select active from reminder_rules where occurrence_id=$1 and origin='system' order by created_at", [occurrenceId]);
  assert.deepEqual(
    rules.rows.map((row) => row.active),
    [false, true],
    "a second snooze retires the first rule instead of leaving two live contacts",
  );
  const superseded = await database.pool.query(
    "select d.status, d.suppressed_reason from reminder_deliveries d join reminder_rules r on r.id = d.reminder_rule_id where r.occurrence_id=$1 and r.active=false",
    [occurrenceId],
  );
  assert.deepEqual(superseded.rows, [{ status: "cancelled", suppressed_reason: "superseded" }]);

  // A closed occurrence has nothing left to postpone.
  await database.pool.query("update task_occurrences set status='done' where id=$1", [occurrenceId]);
  assert.equal(await scheduling.scheduleFollowUpChoice({ workspaceId: scope.workspaceId, userId: scope.userId, occurrenceId, choice: "15m", now }), null);
});

test("the applied report reads occurrences and next reminders for a whole package in two queries", async () => {
  const scope = await fixture();
  const created = [];
  for (let index = 0; index < 5; index += 1) created.push(await createTask(scope, `Пакет ${index}`, 60 + index * 30));
  const scheduling = new ReminderSchedulingService(database, { enqueue: async () => undefined });
  const taskIds = created.map((item) => item.taskId);

  const queries = [];
  const original = database.pool.query.bind(database.pool);
  database.pool.query = (...args) => {
    queries.push(typeof args[0] === "string" ? args[0] : args[0]?.text);
    return original(...args);
  };
  try {
    const occurrences = await tasksRepository.findCurrentOccurrences(scope.workspaceId, taskIds);
    const reminders = await scheduling.nextUserReminderAtMany(
      scope.workspaceId,
      [...occurrences.values()].map((occurrence) => occurrence.id),
    );
    assert.equal(occurrences.size, 5);
    assert.equal(reminders.size, 5);
    for (const occurrence of occurrences.values()) {
      const single = await scheduling.nextUserReminderAt(scope.workspaceId, occurrence.id);
      assert.equal(reminders.get(occurrence.id)?.getTime(), single?.getTime());
    }
  } finally {
    database.pool.query = original;
  }
  // Two batched reads plus the five single reads used to cross-check them.
  assert.equal(queries.length, 7);
});

test("monthly spend is summed per user in one grouped query", async () => {
  const a = await fixture();
  const b = await fixture();
  const ai = new AiRepository(database);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  for (const [scope, cost] of [
    [a, "0.5"],
    [a, "0.25"],
    [b, "2"],
  ]) {
    await database.pool.query(
      "insert into ai_usage(workspace_id, user_id, provider, model, input_tokens, output_tokens, latency_ms, status, estimated_cost_usd) values ($1, $2, 'openai', 'gpt', 1, 1, 10, 'ok', $3)",
      [scope.workspaceId, scope.userId, cost],
    );
  }
  const spend = await ai.monthlySpendByUser(monthStart);
  assert.equal(spend.get(a.userId), 0.75);
  assert.equal(spend.get(b.userId), 2);
  assert.equal(await ai.monthlySpendUsd(a.userId, monthStart), 0.75);
});

test("deletion waits out its grace period, restore cancels it, and the finalizer only removes expired accounts", async () => {
  const scope = await fixture();
  const access = new AccessService(database);
  const telegramId = (await database.pool.query("select telegram_user_id from users where id=$1", [scope.userId])).rows[0].telegram_user_id;
  const now = new Date("2026-09-01T10:00:00Z");

  const deleteAfter = await access.requestDeletion(Number(telegramId), now);
  assert.equal(Math.round((deleteAfter.getTime() - now.getTime()) / 86_400_000), DELETION_GRACE_DAYS);
  assert.equal(await access.finalizeExpiredDeletions(new Date(deleteAfter.getTime() - 1000)), 0);

  assert.equal(await access.restoreDeletion(Number(telegramId), now), true);
  assert.equal((await database.pool.query("select status from users where id=$1", [scope.userId])).rows[0].status, "active");
  assert.equal(await access.finalizeExpiredDeletions(new Date(deleteAfter.getTime() + 1000)), 0);

  await access.requestDeletion(Number(telegramId), now);
  const beforeFinalize = await database.pool.query("select action from admin_audit_log where target_user_id=$1 order by created_at", [scope.userId]);
  assert.deepEqual(
    beforeFinalize.rows.map((row) => row.action),
    ["users:delete-request", "users:delete-restore", "users:delete-request"],
  );
  assert.equal(await access.finalizeExpiredDeletions(new Date(deleteAfter.getTime() + 1000)), 1);
  assert.equal((await database.pool.query("select count(*)::int as count from users where id=$1", [scope.userId])).rows[0].count, 0);
  // The audit trail outlives the account but is anonymised: target_user_id is ON DELETE SET NULL.
  const orphaned = await database.pool.query("select action from admin_audit_log where target_user_id is null");
  assert.ok(orphaned.rows.some((row) => row.action === "users:delete-finalize"));
  assert.equal((await database.pool.query("select count(*)::int as count from admin_audit_log where target_user_id=$1", [scope.userId])).rows[0].count, 0);
});

test("every settings write bumps the version once and a pending input is consumed exactly once", async () => {
  const scope = await fixture();
  const settings = new SettingsService(new SettingsRepository(database));
  const read = async () =>
    (await database.pool.query("select version, morning_digest_enabled, quiet_hours_enabled, timezone from user_settings where user_id=$1", [scope.userId])).rows[0];

  const start = await read();
  await settings.apply(scope.userId, { operation: "digest", kind: "morning", enabled: true });
  const afterDigest = await read();
  assert.equal(afterDigest.version, start.version + 1);
  assert.equal(afterDigest.morning_digest_enabled, true);

  await settings.setTimezone(scope.userId, "Europe/Berlin", { applyTo: "both" });
  const afterTimezone = await read();
  assert.equal(afterTimezone.timezone, "Europe/Berlin");
  assert.ok(afterTimezone.version > afterDigest.version);

  await settings.setPendingInput(scope.userId, { kind: "blocker", occurrenceId: "11111111-1111-1111-1111-111111111111" });
  const first = await settings.consumePendingInput(scope.userId);
  const second = await settings.consumePendingInput(scope.userId);
  assert.deepEqual(first, { kind: "blocker", occurrenceId: "11111111-1111-1111-1111-111111111111" });
  assert.equal(second, null);
});
