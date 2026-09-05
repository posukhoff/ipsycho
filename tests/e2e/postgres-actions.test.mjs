import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../dist/database/database.service.js";
import { ActionsRepository } from "../../dist/actions/actions.repository.js";
import { ContextRepository } from "../../dist/context/context.repository.js";
import { ActionGroupRepository } from "../../dist/actions/action-group.repository.js";
import { AccessService } from "../../dist/access/access.service.js";
import { MessagesRepository } from "../../dist/messages/messages.repository.js";
import { TasksRepository } from "../../dist/tasks/tasks.repository.js";
import { TasksService } from "../../dist/tasks/tasks.service.js";
import { ReminderSchedulingService } from "../../dist/reminders/reminder-scheduling.service.js";
import { actionEvents, actionGroups, memoryItems, messages, taskGoals, taskOccurrences, tasks, userSettings } from "../../dist/database/schema.js";
import { composeTurnContext } from "../../dist/core/turn-context.js";
import { and, eq } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required; run npm run test:e2e");

const database = new DatabaseService({ databaseUrl: url });
const actions = new ActionsRepository(database);
const groups = new ActionGroupRepository(database);
const tasksRepository = new TasksRepository(database);
const contextRepository = new ContextRepository(database);
const access = new AccessService(database);
const messageRepository = new MessagesRepository(database);
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

async function createMemory(workspaceId, userId, content = "Обычно ложусь в 23:00") {
  const id = randomUUID();
  await database.pool.query("insert into memory_items(id, workspace_id, user_id, type, content, sensitive, source) values ($1, $2, $3, 'context', $4, false, 'user_explicit')", [
    id,
    workspaceId,
    userId,
    content,
  ]);
  return id;
}

beforeEach(async () => {
  await database.pool.query("truncate table users cascade");
});

after(async () => {
  await database.onApplicationShutdown();
});

test("profile update is transactional and undo restores the prior fact", async () => {
  const { workspaceId, userId } = await fixture();
  const memoryId = await createMemory(workspaceId, userId);
  const groupId = randomUUID();
  const now = new Date("2026-08-12T09:00:00Z");
  await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now,
    undoExpiresAt: new Date(now.getTime() + 60_000),
    steps: [{ kind: "update_memory", memoryId, expectedVersion: 1, patch: { content: "Обычно ложусь в 00:30", sensitive: true } }],
  });

  const [updated] = await database.db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.workspaceId, workspaceId), eq(memoryItems.id, memoryId)));
  assert.equal(updated?.content, "Обычно ложусь в 00:30");
  assert.equal(updated?.sensitive, true);
  assert.equal(updated?.version, 2);

  const claimed = await actions.claimUndo(workspaceId, userId, groupId, new Date(now.getTime() + 1_000));
  assert.ok(claimed);
  await groups.undo({ workspaceId, groupId, now: new Date(now.getTime() + 2_000) });

  const [restored] = await database.db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.workspaceId, workspaceId), eq(memoryItems.id, memoryId)));
  assert.equal(restored?.content, "Обычно ложусь в 23:00");
  assert.equal(restored?.sensitive, false);
  assert.equal(restored?.version, 3);
});

test("stale concurrent profile edits cannot both overwrite one fact", async () => {
  const { workspaceId, userId } = await fixture();
  const memoryId = await createMemory(workspaceId, userId);
  const now = new Date();
  const attempt = async (content) => {
    return groups.apply({
      workspaceId,
      actorUserId: userId,
      groupId: randomUUID(),
      groupExists: false,
      now,
      undoExpiresAt: new Date(now.getTime() + 60_000),
      steps: [{ kind: "update_memory", memoryId, expectedVersion: 1, patch: { content } }],
    });
  };
  const results = await Promise.allSettled([attempt("Ложусь в 23:30"), attempt("Ложусь в 00:30")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const [memory] = await database.db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.workspaceId, workspaceId), eq(memoryItems.id, memoryId)));
  assert.equal(memory?.version, 2);
});

test("chat settings update is atomic, versioned and undoable", async () => {
  const { workspaceId, userId } = await fixture();
  const groupId = randomUUID();
  const now = new Date("2026-08-12T09:00:00Z");
  await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now,
    undoExpiresAt: new Date(now.getTime() + 60_000),
    steps: [{ kind: "update_settings", expectedVersion: 1, patch: { morningDigestEnabled: true, morningReferenceTime: "08:30" } }],
  });
  let [settings] = await database.db.select().from(userSettings).where(eq(userSettings.userId, userId));
  assert.equal(settings?.morningDigestEnabled, true);
  assert.equal(settings?.morningReferenceTime, "08:30");
  assert.equal(settings?.version, 2);
  const claimed = await actions.claimUndo(workspaceId, userId, groupId, new Date(now.getTime() + 1_000));
  assert.ok(claimed);
  await groups.undo({ workspaceId, groupId, now: new Date(now.getTime() + 2_000) });
  [settings] = await database.db.select().from(userSettings).where(eq(userSettings.userId, userId));
  assert.equal(settings?.morningDigestEnabled, false);
  assert.equal(settings?.morningReferenceTime, "09:00");
  assert.equal(settings?.version, 3);
});

test("stale chat settings cannot overwrite a newer settings version", async () => {
  const { workspaceId, userId } = await fixture();
  const now = new Date();
  const attempt = async (time) => {
    return groups.apply({
      workspaceId,
      actorUserId: userId,
      groupId: randomUUID(),
      groupExists: false,
      now,
      undoExpiresAt: new Date(now.getTime() + 60_000),
      steps: [{ kind: "update_settings", expectedVersion: 1, patch: { morningReferenceTime: time } }],
    });
  };
  const results = await Promise.allSettled([attempt("08:00"), attempt("08:30")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("one Telegram message can seed at most one active action group", async () => {
  const { workspaceId, userId } = await fixture();
  const first = await messageRepository.saveOnce({
    workspaceId,
    userId,
    role: "user",
    status: "processing",
    content: "Создай задачу",
    telegramChatId: telegramUserSequence,
    telegramMessageId: 42,
  });
  const duplicate = await messageRepository.saveOnce({
    workspaceId,
    userId,
    role: "user",
    status: "processing",
    content: "Создай задачу",
    telegramChatId: telegramUserSequence,
    telegramMessageId: 42,
  });
  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.message?.id, first.message?.id);

  const firstGroupId = randomUUID();
  await actions.createImmediateGroup({ id: firstGroupId, workspaceId, actorUserId: userId, sourceMessageId: first.message.id });
  await assert.rejects(
    actions.createImmediateGroup({ id: randomUUID(), workspaceId, actorUserId: userId, sourceMessageId: first.message.id }),
    (error) => error?.cause?.constraint === "action_groups_active_source_message_uq",
  );

  await actions.markFailed(workspaceId, firstGroupId);
  await actions.createImmediateGroup({ id: randomUUID(), workspaceId, actorUserId: userId, sourceMessageId: first.message.id });
  const storedMessages = await database.db.select().from(messages).where(eq(messages.id, first.message.id));
  assert.equal(storedMessages.length, 1);
});

async function createOccurrence(workspaceId, userId) {
  const taskId = randomUUID();
  const occurrenceId = randomUUID();
  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone, planned_start_at) values ($1,$2,$3,'Тестовая задача','task','normal','active','point','Europe/Kyiv',$4)",
    [taskId, workspaceId, userId, new Date(Date.now() - 60_000)],
  );
  await database.pool.query("insert into task_occurrences(id, workspace_id, task_id, status, timezone, planned_start_at) values ($1,$2,$3,'open','Europe/Kyiv',$4)", [
    occurrenceId,
    workspaceId,
    taskId,
    new Date(Date.now() - 60_000),
  ]);
  return { taskId, occurrenceId };
}

test("task-card lifecycle and action journal commit in one transaction and undo cleanly", async () => {
  const { workspaceId, userId } = await fixture();
  const { taskId, occurrenceId } = await createOccurrence(workspaceId, userId);
  // Skipping one date is a recurring-task operation, so this fixture is a series.
  await database.pool.query("update tasks set recurrence_rule='FREQ=DAILY', recurrence_timezone='Europe/Kyiv' where id=$1", [taskId]);
  const groupId = randomUUID();
  const now = new Date();
  await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now,
    undoExpiresAt: new Date(now.getTime() + 60_000),
    steps: [{ kind: "update_occurrence", occurrenceId, expectedVersion: 1, operation: "skip" }],
  });
  let [occurrence] = await database.db.select().from(taskOccurrences).where(eq(taskOccurrences.id, occurrenceId));
  let [group] = await database.db.select().from(actionGroups).where(eq(actionGroups.id, groupId));
  assert.equal(occurrence?.status, "skipped");
  assert.equal(occurrence?.version, 2);
  assert.equal(group?.status, "applied");
  const claimed = await actions.claimUndo(workspaceId, userId, groupId, new Date(now.getTime() + 1_000));
  assert.ok(claimed);
  await groups.undo({ workspaceId, groupId, now: new Date(now.getTime() + 2_000) });
  [occurrence] = await database.db.select().from(taskOccurrences).where(eq(taskOccurrences.id, occurrenceId));
  assert.equal(occurrence?.status, "open");
  assert.equal(occurrence?.version, 3);
});

test("only one concurrent confirmation may claim a pending action group", async () => {
  const { workspaceId, userId } = await fixture();
  const groupId = randomUUID();
  await actions.createPendingGroup({
    id: groupId,
    workspaceId,
    actorUserId: userId,
    expiresAt: new Date(Date.now() + 60_000),
    actions: [{ id: randomUUID(), actionType: "update_memory", payload: { type: "update_memory" } }],
  });
  const [first, second] = await Promise.all([
    actions.claimPendingGroup(workspaceId, userId, groupId, new Date()),
    actions.claimPendingGroup(workspaceId, userId, groupId, new Date()),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
  const claimed = first ?? second;
  assert.equal(claimed?.actions.length, 1);
  const events = await database.db.select().from(actionEvents).where(eq(actionEvents.groupId, groupId));
  assert.equal(events.length, 0);
});

test("startup expires pending proposals stored under the old contract and records an audit event", async () => {
  const { workspaceId, userId } = await fixture();
  const legacyGroupId = randomUUID();
  const freshGroupId = randomUUID();
  await actions.createPendingGroup({
    id: legacyGroupId,
    workspaceId,
    actorUserId: userId,
    expiresAt: new Date(Date.now() + 60_000),
    actions: [{ id: randomUUID(), actionType: "task_batch", payload: { type: "task_batch", steps: [] } }],
  });
  await actions.createPendingGroup({
    id: freshGroupId,
    workspaceId,
    actorUserId: userId,
    expiresAt: new Date(Date.now() + 60_000),
    actions: [{ id: randomUUID(), actionType: "memory", payload: { type: "memory", intent: "inferred", op: "save" } }],
  });
  const isValid = (actionType, payload) => actionType === "memory" && payload?.intent !== undefined;
  assert.equal(await actions.expireLegacyPendingGroups(new Date(), isValid), 1);
  assert.equal((await database.pool.query("select status from action_groups where id=$1", [legacyGroupId])).rows[0].status, "cancelled");
  assert.equal((await database.pool.query("select id from pending_actions where group_id=$1", [legacyGroupId])).rowCount, 0);
  const audit = await database.pool.query("select action_type, entity_type, after_state from action_events where group_id=$1", [legacyGroupId]);
  assert.equal(audit.rows[0].action_type, "legacy_contract_expired");
  assert.equal(audit.rows[0].entity_type, "action_group");
  assert.equal(audit.rows[0].after_state.reason, "contract_v2");
  const fresh = await actions.findPendingGroup(workspaceId, userId, freshGroupId, new Date());
  assert.equal(fresh?.status, "pending");
  assert.deepEqual(
    fresh?.actions.map((action) => action.actionType),
    ["memory"],
  );
  assert.equal(await actions.findPendingGroup(workspaceId, userId, legacyGroupId, new Date()), null);
});

test("the E2E database includes every migration required by the running schema", async () => {
  const { rows } = await database.pool.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'user_settings' and column_name = 'profile_invited_at'",
  );
  assert.deepEqual(
    rows.map((row) => row.column_name),
    ["profile_invited_at"],
  );
  const version = await database.pool.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'user_settings' and column_name = 'version'",
  );
  assert.deepEqual(
    version.rows.map((row) => row.column_name),
    ["version"],
  );
  const pendingGroup = await database.pool.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'messages' and column_name = 'pending_group_id'",
  );
  assert.deepEqual(
    pendingGroup.rows.map((row) => row.column_name),
    ["pending_group_id"],
  );
});

test("recurrence exclusions are unique and cannot cross workspace boundaries", async () => {
  const owner = await fixture();
  const other = await fixture();
  const taskId = randomUUID();
  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone, planned_start_at, recurrence_rule, recurrence_timezone, recurrence_end_local_date) values ($1,$2,$3,'Ограниченная серия','task','normal','active','point','Europe/Kyiv','2026-09-01T06:00:00Z','FREQ=DAILY','Europe/Kyiv','2026-09-30')",
    [taskId, owner.workspaceId, owner.userId],
  );
  await database.pool.query("insert into task_recurrence_exclusions(workspace_id, task_id, local_date) values ($1,$2,'2026-09-10')", [owner.workspaceId, taskId]);
  await assert.rejects(
    database.pool.query("insert into task_recurrence_exclusions(workspace_id, task_id, local_date) values ($1,$2,'2026-09-10')", [owner.workspaceId, taskId]),
    (error) => error?.constraint === "task_recurrence_exclusions_pkey",
  );
  await assert.rejects(
    database.pool.query("insert into task_recurrence_exclusions(workspace_id, task_id, local_date) values ($1,$2,'2026-09-11')", [other.workspaceId, taskId]),
    (error) => {
      assert.match(error?.constraint ?? "", /task_recurrence_exclusions.*fkey/);
      return true;
    },
  );
});

async function createGoal(workspaceId, userId, title = "Цель") {
  const goalId = randomUUID();
  await database.pool.query("insert into goals(id, workspace_id, created_by_user_id, title) values ($1,$2,$3,$4)", [goalId, workspaceId, userId, title]);
  return goalId;
}

async function createFuzzyTask(workspaceId, userId, title = "Разобрать гараж") {
  const taskId = randomUUID();
  const ruleId = randomUUID();
  const deliveryId = randomUUID();
  const reviewAt = new Date(Date.now() + 3 * 86_400_000);
  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone, fuzzy_horizon_text, review_at) values ($1,$2,$3,$4,'task','normal','active','fuzzy','Europe/Kyiv','на этой неделе',$5)",
    [taskId, workspaceId, userId, title, reviewAt],
  );
  await database.pool.query(
    "insert into reminder_rules(id, workspace_id, task_id, trigger_kind, anchor, offset_seconds, purpose, quiet_policy, origin, active) values ($1,$2,$3,'relative_timestamp','review_at',0,'planning_review','respect','default',true)",
    [ruleId, workspaceId, taskId],
  );
  await database.pool.query(
    "insert into reminder_deliveries(id, workspace_id, recipient_user_id, reminder_rule_id, task_id, intended_for, scheduled_for, status, deduplication_key) values ($1,$2,$3,$4,$5,$6,$6,'pending',$7)",
    [deliveryId, workspaceId, userId, ruleId, taskId, reviewAt, `${ruleId}:task:${reviewAt.toISOString()}`],
  );
  return { taskId, ruleId, deliveryId };
}

function planFor(workspaceId, userId, groupId, taskId, title = "Новая задача") {
  const occurrenceId = randomUUID();
  const startAt = new Date(Date.now() + 2 * 3_600_000);
  return {
    task: {
      id: taskId,
      workspaceId,
      createdByUserId: userId,
      sourceActionGroupId: groupId,
      title,
      kind: "task",
      importance: "normal",
      status: "active",
      timeMode: "point",
      timezone: "Europe/Kyiv",
      plannedStartAt: startAt,
    },
    occurrences: [{ id: occurrenceId, workspaceId, taskId, seriesRevision: 1, status: "scheduled", timezone: "Europe/Kyiv", plannedStartAt: startAt }],
    reminderRules: [],
    reminderDeliveries: [],
    checklist: [],
    recurrenceExclusions: [],
  };
}

test("a mixed action group applies atomically and undoes atomically", async () => {
  const { workspaceId, userId } = await fixture();
  const goalId = await createGoal(workspaceId, userId);
  const { taskId: existingTaskId, occurrenceId } = await createOccurrence(workspaceId, userId);
  const now = new Date();
  const nextStart = new Date(now.getTime() + 24 * 3_600_000);
  const groupId = randomUUID();
  const taskId = randomUUID();
  const applied = await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now,
    undoExpiresAt: new Date(now.getTime() + 60_000),
    steps: [
      { kind: "create_task", plan: planFor(workspaceId, userId, groupId, taskId), goalLink: null },
      { kind: "link_task_to_goal", taskId, expectedTaskVersion: 1, goalId, expectedGoalVersion: 1, source: "user_explicit", confidence: 1 },
      { kind: "reschedule_occurrence", occurrenceId, expectedVersion: 1, scheduleTimezone: "Europe/Kyiv", schedule: { plannedStartAt: nextStart }, reason: "перенос" },
    ],
  });
  assert.deepEqual(
    applied.steps.map((step) => step.kind),
    ["create_task", "link_task_to_goal", "reschedule_occurrence"],
  );
  assert.equal(applied.steps[1].goalTitle, "Цель");
  assert.equal(applied.steps[2].title, "Тестовая задача");
  assert.equal(applied.steps[2].occurrenceSchedule.plannedStartAt.toISOString(), nextStart.toISOString());
  assert.deepEqual(applied.reminderRebuildOccurrenceIds, [occurrenceId]);
  assert.deepEqual(applied.createdTaskIds, [taskId]);
  assert.equal(applied.preparedPlans.length, 1);
  assert.equal((await database.pool.query("select id from tasks where id=$1", [taskId])).rowCount, 1);
  assert.equal((await database.pool.query("select task_id from task_goals where task_id=$1 and goal_id=$2", [taskId, goalId])).rowCount, 1);
  const [moved] = await database.db.select().from(taskOccurrences).where(eq(taskOccurrences.id, occurrenceId));
  assert.equal(moved.version, 2);
  assert.equal(moved.plannedStartAt.toISOString(), nextStart.toISOString());
  const [movedTask] = await database.db.select().from(tasks).where(eq(tasks.id, existingTaskId));
  assert.equal(movedTask.version, 2);
  assert.equal((await database.pool.query("select status from action_groups where id=$1 and status='applied'", [groupId])).rowCount, 1);

  const claim = await actions.claimUndo(workspaceId, userId, groupId, new Date());
  assert.ok(claim);
  const undone = await groups.undo({ workspaceId, groupId, now: new Date() });
  assert.deepEqual(undone.reminderRebuildOccurrenceIds, [occurrenceId]);
  assert.equal((await database.pool.query("select id from tasks where id=$1", [taskId])).rowCount, 0);
  assert.equal((await database.pool.query("select task_id from task_goals where task_id=$1", [taskId])).rowCount, 0);
  const [restored] = await database.db.select().from(taskOccurrences).where(eq(taskOccurrences.id, occurrenceId));
  assert.equal(restored.version, 3);
  assert.ok(restored.plannedStartAt < now);
  const [restoredTask] = await database.db.select().from(tasks).where(eq(tasks.id, existingTaskId));
  assert.equal(restoredTask.version, 3);
  assert.equal((await database.pool.query("select status from action_groups where id=$1 and status='undone'", [groupId])).rowCount, 1);
});

test("a failing last step rolls back every earlier step of the group", async () => {
  const { workspaceId, userId } = await fixture();
  const goalId = await createGoal(workspaceId, userId);
  const groupId = randomUUID();
  const taskId = randomUUID();
  const link = { kind: "link_task_to_goal", taskId, expectedTaskVersion: 1, goalId, expectedGoalVersion: 1, source: "user_explicit", confidence: 1 };
  await assert.rejects(
    groups.apply({
      workspaceId,
      actorUserId: userId,
      groupId,
      groupExists: false,
      now: new Date(),
      undoExpiresAt: new Date(Date.now() + 60_000),
      steps: [{ kind: "create_task", plan: planFor(workspaceId, userId, groupId, taskId), goalLink: null }, link, { ...link }],
    }),
    /already linked/,
  );
  assert.equal((await database.pool.query("select id from tasks where id=$1", [taskId])).rowCount, 0);
  assert.equal((await database.pool.query("select id from action_groups where id=$1", [groupId])).rowCount, 0);
  assert.equal((await database.pool.query("select id from action_events where group_id=$1", [groupId])).rowCount, 0);
});

test("a group addresses one task twice on its own versions, and only a concurrent change makes it stale", async () => {
  const { workspaceId, userId } = await fixture();
  const { taskId } = await createFuzzyTask(workspaceId, userId, "Исходная");
  const groupId = randomUUID();
  const applied = await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now: new Date(),
    undoExpiresAt: new Date(Date.now() + 60_000),
    steps: [
      { kind: "update_task", taskId, expectedVersion: 1, patch: { title: "Переименована" } },
      { kind: "update_task", taskId, expectedVersion: 1, patch: { why: "потому что" } },
    ],
  });
  assert.equal(applied.steps[0].renamedFrom, "Исходная");
  assert.equal(applied.steps[1].title, "Переименована");
  const row = (await database.pool.query("select title, why, version from tasks where id=$1", [taskId])).rows[0];
  assert.deepEqual(row, { title: "Переименована", why: "потому что", version: 3 });

  await assert.rejects(
    groups.apply({
      workspaceId,
      actorUserId: userId,
      groupId: randomUUID(),
      groupExists: false,
      now: new Date(),
      undoExpiresAt: new Date(Date.now() + 60_000),
      steps: [{ kind: "update_task", taskId, expectedVersion: 1, patch: { title: "Устаревшая" } }],
    }),
    /stale/,
  );

  const claim = await actions.claimUndo(workspaceId, userId, groupId, new Date());
  assert.ok(claim);
  await groups.undo({ workspaceId, groupId, now: new Date() });
  assert.deepEqual((await database.pool.query("select title, why, version from tasks where id=$1", [taskId])).rows[0], { title: "Исходная", why: null, version: 4 });
});

test("concurrent groups cannot both apply the same expected task version", async () => {
  const { workspaceId, userId } = await fixture();
  const { taskId } = await createFuzzyTask(workspaceId, userId, "Исходная");
  const attempt = (title) =>
    groups.apply({
      workspaceId,
      actorUserId: userId,
      groupId: randomUUID(),
      groupExists: false,
      steps: [{ kind: "update_task", taskId, expectedVersion: 1, patch: { title } }],
      now: new Date(),
      undoExpiresAt: new Date(Date.now() + 60_000),
    });
  const results = await Promise.allSettled([attempt("Первый вариант"), attempt("Второй вариант")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /stale/);
  const row = (await database.pool.query("select title, version from tasks where id=$1", [taskId])).rows[0];
  assert.ok(["Первый вариант", "Второй вариант"].includes(row.title));
  assert.equal(row.version, 2);
  assert.equal((await database.pool.query("select count(*)::int as count from action_groups where workspace_id=$1 and status='applied'", [workspaceId])).rows[0].count, 1);
});

test("undo refuses a group whose task changed afterwards", async () => {
  const { workspaceId, userId } = await fixture();
  const groupId = randomUUID();
  const taskId = randomUUID();
  await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now: new Date(),
    undoExpiresAt: new Date(Date.now() + 60_000),
    steps: [{ kind: "create_task", plan: planFor(workspaceId, userId, groupId, taskId), goalLink: null }],
  });
  await database.pool.query("update tasks set title='Изменено позже', version=version+1 where id=$1", [taskId]);
  const claim = await actions.claimUndo(workspaceId, userId, groupId, new Date());
  assert.ok(claim);
  await assert.rejects(groups.undo({ workspaceId, groupId, now: new Date() }), /changed after/);
  assert.equal((await database.pool.query("select title from tasks where id=$1", [taskId])).rows[0].title, "Изменено позже");
});

test("cancelling a fuzzy task retires its planning review and undo brings both back", async () => {
  const { workspaceId, userId } = await fixture();
  const { taskId, ruleId, deliveryId } = await createFuzzyTask(workspaceId, userId);
  const groupId = randomUUID();
  const now = new Date();
  const applied = await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now,
    undoExpiresAt: new Date(now.getTime() + 60_000),
    steps: [{ kind: "cancel_task", taskId, expectedVersion: 1 }],
  });
  assert.deepEqual(applied.steps, [{ kind: "cancel_task", taskId, occurrenceId: null, title: "Разобрать гараж" }]);
  assert.equal((await database.pool.query("select status from tasks where id=$1", [taskId])).rows[0].status, "cancelled");
  assert.equal((await database.pool.query("select active from reminder_rules where id=$1", [ruleId])).rows[0].active, false);
  assert.equal((await database.pool.query("select status from reminder_deliveries where id=$1", [deliveryId])).rows[0].status, "suppressed");
  assert.equal((await database.pool.query("select id from action_events where group_id=$1 and action_type='cancel_task' and entity_type='task'", [groupId])).rowCount, 1);
  assert.equal((await database.pool.query("select id from task_events where task_id=$1 and event_type='task:cancelled'", [taskId])).rowCount, 1);

  const claim = await actions.claimUndo(workspaceId, userId, groupId, new Date());
  assert.ok(claim);
  const undone = await groups.undo({ workspaceId, groupId, now: new Date() });
  assert.deepEqual(undone.fuzzyRebuildTaskIds, [taskId]);
  assert.deepEqual((await database.pool.query("select status, version from tasks where id=$1", [taskId])).rows[0], { status: "active", version: 3 });
  assert.equal((await database.pool.query("select active from reminder_rules where id=$1", [ruleId])).rows[0].active, true);
  assert.equal((await database.pool.query("select status from reminder_deliveries where id=$1", [deliveryId])).rows[0].status, "pending");
});

test("a fuzzy task given a time gets its first occurrence and default reminders, and undo removes them", async () => {
  const { workspaceId, userId } = await fixture();
  const { taskId, ruleId } = await createFuzzyTask(workspaceId, userId);
  const groupId = randomUUID();
  const now = new Date();
  const plannedStartAt = new Date(now.getTime() + 48 * 3_600_000);
  const applied = await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now,
    undoExpiresAt: new Date(now.getTime() + 60_000),
    steps: [
      {
        kind: "concretise_task",
        taskId,
        expectedVersion: 1,
        occurrenceStatus: "scheduled",
        reason: "нашлось время",
        definition: { kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv", plannedStartAt },
      },
    ],
  });
  const step = applied.steps[0];
  assert.equal(step.kind, "concretise_task");
  assert.equal(step.previousFuzzyHorizonText, "на этой неделе");
  assert.equal(step.occurrenceSchedule.plannedStartAt.toISOString(), plannedStartAt.toISOString());
  assert.deepEqual(applied.reminderRebuildOccurrenceIds, [step.occurrenceId]);
  const task = (await database.pool.query("select time_mode, fuzzy_horizon_text, review_at, planned_start_at, version from tasks where id=$1", [taskId])).rows[0];
  assert.equal(task.time_mode, "point");
  assert.equal(task.fuzzy_horizon_text, null);
  assert.equal(task.review_at, null);
  assert.equal(new Date(task.planned_start_at).toISOString(), plannedStartAt.toISOString());
  const occurrence = (
    await database.pool.query("select status, series_revision, version, needs_reminder_rebuild from task_occurrences where id=$1 and task_id=$2", [step.occurrenceId, taskId])
  ).rows[0];
  assert.deepEqual(occurrence, { status: "scheduled", series_revision: 1, version: 1, needs_reminder_rebuild: true });
  const rules = (await database.pool.query("select purpose, origin, active, anchor from reminder_rules where task_id=$1 order by purpose", [taskId])).rows;
  assert.deepEqual(
    rules.find((rule) => rule.purpose === "planning_review"),
    { purpose: "planning_review", origin: "default", active: false, anchor: "review_at" },
  );
  const defaults = rules.filter((rule) => rule.purpose !== "planning_review");
  assert.ok(defaults.length >= 1);
  assert.ok(defaults.every((rule) => rule.active && rule.origin === "default"));
  const events = (await database.pool.query("select action_type, entity_type, post_version, before_state from action_events where group_id=$1 order by action_type", [groupId]))
    .rows;
  assert.deepEqual(
    events.map((event) => [event.action_type, event.entity_type, event.post_version]),
    [
      ["concretise_task", "task", 2],
      ["occurrence_created", "occurrence", 1],
    ],
  );
  assert.equal(events[1].before_state, null);

  const claim = await actions.claimUndo(workspaceId, userId, groupId, new Date());
  assert.ok(claim);
  const undone = await groups.undo({ workspaceId, groupId, now: new Date() });
  assert.deepEqual(undone.fuzzyRebuildTaskIds, [taskId]);
  assert.equal((await database.pool.query("select id from task_occurrences where id=$1", [step.occurrenceId])).rowCount, 0);
  const restored = (await database.pool.query("select time_mode, fuzzy_horizon_text, version from tasks where id=$1", [taskId])).rows[0];
  assert.deepEqual(restored, { time_mode: "fuzzy", fuzzy_horizon_text: "на этой неделе", version: 3 });
  const rulesAfter = (await database.pool.query("select id, purpose, active from reminder_rules where task_id=$1", [taskId])).rows;
  assert.deepEqual(rulesAfter, [{ id: ruleId, purpose: "planning_review", active: true }]);
});

test("findCurrentOccurrence prefers in-progress, then open, then the nearest scheduled, and elapsed only on request", async () => {
  const { workspaceId, userId } = await fixture();
  const taskId = randomUUID();
  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone, planned_start_at, recurrence_rule, recurrence_timezone) values ($1,$2,$3,'Серия','task','normal','active','point','Europe/Kyiv',$4,'FREQ=DAILY','Europe/Kyiv')",
    [taskId, workspaceId, userId, new Date()],
  );
  const insert = async (status, offsetHours) => {
    const id = randomUUID();
    await database.pool.query("insert into task_occurrences(id, workspace_id, task_id, status, timezone, planned_start_at) values ($1,$2,$3,$4,'Europe/Kyiv',$5)", [
      id,
      workspaceId,
      taskId,
      status,
      new Date(Date.now() + offsetHours * 3_600_000),
    ]);
    return id;
  };
  const elapsed = await insert("elapsed", -30);
  assert.equal(await tasksRepository.findCurrentOccurrence(workspaceId, taskId), null);
  assert.equal((await tasksRepository.findCurrentOccurrence(workspaceId, taskId, { includeElapsed: true }))?.id, elapsed);
  const later = await insert("scheduled", 48);
  const sooner = await insert("scheduled", 24);
  assert.equal((await tasksRepository.findCurrentOccurrence(workspaceId, taskId, { includeElapsed: true }))?.id, sooner);
  const open = await insert("open", 72);
  assert.equal((await tasksRepository.findCurrentOccurrence(workspaceId, taskId))?.id, open);
  const inProgress = await insert("in_progress", 96);
  assert.equal((await tasksRepository.findCurrentOccurrence(workspaceId, taskId))?.id, inProgress);
  assert.equal(await tasksRepository.findCurrentOccurrence(randomUUID(), taskId), null);
  assert.notEqual(later, sooner);
});

test("a paused series comes back: resume restores its future dates and asks for reconciliation", async () => {
  const { workspaceId, userId } = await fixture();
  const taskId = randomUUID();
  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone, planned_start_at, recurrence_rule, recurrence_timezone) values ($1,$2,$3,'Зарядка','task','normal','active','point','Europe/Kyiv',$4,'FREQ=DAILY','Europe/Kyiv')",
    [taskId, workspaceId, userId, new Date(Date.now() + 24 * 3_600_000)],
  );
  const occurrenceIds = [randomUUID(), randomUUID()];
  for (const [index, id] of occurrenceIds.entries()) {
    await database.pool.query("insert into task_occurrences(id, workspace_id, task_id, status, timezone, planned_start_at) values ($1,$2,$3,'scheduled','Europe/Kyiv',$4)", [
      id,
      workspaceId,
      taskId,
      new Date(Date.now() + (index + 1) * 24 * 3_600_000),
    ]);
  }

  const paused = await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId: randomUUID(),
    groupExists: false,
    now: new Date(),
    undoExpiresAt: new Date(Date.now() + 60_000),
    steps: [{ kind: "change_series", taskId, expectedVersion: 1, operation: "pause" }],
  });
  assert.equal(paused.reconcileTaskIds.length, 0);
  const afterPause = (await database.pool.query("select status, version from tasks where id=$1", [taskId])).rows[0];
  assert.equal(afterPause.status, "paused");
  const cancelled = (await database.pool.query("select status, skip_reason from task_occurrences where task_id=$1", [taskId])).rows;
  assert.deepEqual(
    cancelled.map((row) => [row.status, row.skip_reason]),
    [
      ["cancelled", "series_paused_projection"],
      ["cancelled", "series_paused_projection"],
    ],
  );

  const resumed = await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId: randomUUID(),
    groupExists: false,
    now: new Date(),
    undoExpiresAt: new Date(Date.now() + 60_000),
    steps: [{ kind: "change_series", taskId, expectedVersion: afterPause.version, operation: "resume" }],
  });
  // Without reconciliation the series would come back with only the dates it had before the pause.
  assert.deepEqual(resumed.reconcileTaskIds, [taskId]);
  assert.equal((await database.pool.query("select status from tasks where id=$1", [taskId])).rows[0].status, "active");
  const back = (await database.pool.query("select status, skip_reason from task_occurrences where task_id=$1", [taskId])).rows;
  assert.equal(back.filter((row) => row.status !== "cancelled" && row.skip_reason === null).length, 2, "both future dates are live again");
});

test("unlinking a task from its goal is journaled with the link it removed and undo restores it", async () => {
  const { workspaceId, userId } = await fixture();
  const goalId = await createGoal(workspaceId, userId, "Здоровье");
  const { taskId } = await createFuzzyTask(workspaceId, userId, "Зарядка");
  await database.pool.query("insert into task_goals(workspace_id, task_id, goal_id, source, confidence) values ($1,$2,$3,'ai_inferred',80)", [workspaceId, taskId, goalId]);
  const groupId = randomUUID();
  const applied = await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now: new Date(),
    undoExpiresAt: new Date(Date.now() + 60_000),
    steps: [{ kind: "unlink_task_to_goal", taskId, expectedTaskVersion: 1, goalId, expectedGoalVersion: 1 }],
  });
  assert.deepEqual(applied.steps, [{ kind: "unlink_task_to_goal", taskId, goalId, taskTitle: "Зарядка", goalTitle: "Здоровье" }]);
  assert.equal((await database.pool.query("select task_id from task_goals where task_id=$1", [taskId])).rowCount, 0);
  const [event] = await database.db.select().from(actionEvents).where(eq(actionEvents.groupId, groupId));
  assert.equal(event.actionType, "unlink_task_to_goal");
  assert.equal(event.entityType, "task_goal");
  assert.deepEqual(event.beforeState, { taskId, goalId, source: "ai_inferred", confidence: 80 });

  const claim = await actions.claimUndo(workspaceId, userId, groupId, new Date());
  assert.ok(claim);
  await groups.undo({ workspaceId, groupId, now: new Date() });
  const [link] = await database.db
    .select()
    .from(taskGoals)
    .where(and(eq(taskGoals.taskId, taskId), eq(taskGoals.goalId, goalId)));
  assert.equal(link?.source, "ai_inferred");
  assert.equal(link?.confidence, 80);
});

test("an assistant message remembers the proposal card it carries", async () => {
  const { workspaceId, userId } = await fixture();
  const other = await fixture();
  const groupId = randomUUID();
  await actions.createPendingGroup({
    id: groupId,
    workspaceId,
    actorUserId: userId,
    expiresAt: new Date(Date.now() + 60_000),
    actions: [{ id: randomUUID(), actionType: "memory", payload: { type: "memory" } }],
  });
  await messageRepository.save({ workspaceId, userId, role: "user", content: "запомни" });
  const card = await messageRepository.save({
    workspaceId,
    userId,
    role: "assistant",
    content: "Сохранить? да/нет",
    telegramChatId: 7,
    telegramMessageId: 100,
    pendingGroupId: groupId,
  });
  const last = await messageRepository.findLastAssistantMessage(workspaceId, userId);
  assert.equal(last?.id, card.id);
  assert.equal(last?.pendingGroupId, groupId);
  assert.equal(last?.telegramChatId, 7);
  assert.equal(last?.telegramMessageId, 100);
  assert.equal((await messageRepository.findByPendingGroup(workspaceId, groupId))?.id, card.id);
  assert.equal(await messageRepository.findByPendingGroup(other.workspaceId, groupId), null);

  await messageRepository.save({ workspaceId, userId, role: "assistant", content: "Готово" });
  assert.equal((await messageRepository.findLastAssistantMessage(workspaceId, userId))?.pendingGroupId, null);
  await assert.rejects(
    messageRepository.save({ workspaceId: other.workspaceId, userId: other.userId, role: "assistant", content: "чужая карточка", pendingGroupId: groupId }),
    (error) => /messages_pending_group_workspace_fk/.test(error?.cause?.constraint ?? error?.cause?.message ?? ""),
  );
  await database.pool.query("delete from action_groups where id=$1", [groupId]);
  const [orphaned] = await database.db.select().from(messages).where(eq(messages.id, card.id));
  assert.equal(orphaned.pendingGroupId, null);
  assert.equal(orphaned.workspaceId, workspaceId);
});

test("task search and the AI task list stay inside the workspace", async () => {
  const owner = await fixture();
  const other = await fixture();
  const insertTask = (workspaceId, userId, title, status = "active") =>
    database.pool.query(
      "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone, context) values ($1,$2,$3,$4,'task','normal',$5,'fuzzy','Europe/Kyiv','после работы')",
      [randomUUID(), workspaceId, userId, title, status],
    );
  await insertTask(owner.workspaceId, owner.userId, "Купить молоко");
  await insertTask(owner.workspaceId, owner.userId, "Позвонить маме", "paused");
  await insertTask(owner.workspaceId, owner.userId, "Старое молоко", "closed");
  await insertTask(other.workspaceId, other.userId, "Купить молоко");
  for (let index = 0; index < 14; index += 1) await insertTask(owner.workspaceId, owner.userId, `Задача ${index}`);

  const found = await tasksRepository.searchActiveTasks(owner.workspaceId, "молоко");
  assert.deepEqual(
    found.map((task) => task.title),
    ["Купить молоко"],
  );
  assert.ok(found.every((task) => task.workspaceId === owner.workspaceId));
  const byContext = await tasksRepository.searchActiveTasks(owner.workspaceId, "работы");
  assert.equal(byContext.length, 16);
  assert.ok(byContext.every((task) => task.status !== "closed"));
  assert.deepEqual(await tasksRepository.searchActiveTasks(owner.workspaceId, "   "), []);
  const listed = await tasksRepository.listActiveTasksForAi(owner.workspaceId);
  assert.equal(listed.length, 16);
  assert.ok(listed.some((task) => task.status === "paused"));
  assert.ok(listed.every((task) => task.status !== "closed" && task.workspaceId === owner.workspaceId));
});

test("a saved note is found by an inflected form of one content word in the message", async () => {
  const { workspaceId, userId } = await fixture();
  await database.pool.query("insert into memory_items(id, workspace_id, user_id, type, content, sensitive, source) values ($1, $2, $3, 'note', $4, false, 'user_explicit')", [
    randomUUID(),
    workspaceId,
    userId,
    "Пью таблетки от давления каждое утро",
  ]);
  await database.pool.query("insert into memory_items(id, workspace_id, user_id, type, content, sensitive, source) values ($1, $2, $3, 'note', $4, false, 'user_explicit')", [
    randomUUID(),
    workspaceId,
    userId,
    "Кошку зовут Мурка",
  ]);
  const found = await contextRepository.searchMemory(workspaceId, userId, "Напомни про таблетки завтра утром");
  assert.deepEqual(
    found.map((item) => item.content),
    ["Пью таблетки от давления каждое утро"],
  );
  assert.deepEqual(await contextRepository.searchMemory(workspaceId, userId, "да, давай"), []);

  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone) values ($1,$2,$3,'Забрать посылку на почте','task','normal','active','fuzzy','Europe/Kyiv')",
    [randomUUID(), workspaceId, userId],
  );
  const tasksFound = await tasksRepository.searchActiveTasks(workspaceId, "Перенеси посылка на четверг");
  assert.deepEqual(
    tasksFound.map((task) => task.title),
    ["Забрать посылку на почте"],
  );
});

test("sensitive profile and memory facts never enter the AI context", async () => {
  const { workspaceId, userId } = await fixture();
  await createMemory(workspaceId, userId, "Usually plans important work before noon");
  await database.pool.query("insert into memory_items(id, workspace_id, user_id, type, content, sensitive, source) values ($1, $2, $3, 'context', $4, true, 'user_explicit')", [
    randomUUID(),
    workspaceId,
    userId,
    "Private medical detail",
  ]);
  const [profile, memoryMatches] = await Promise.all([contextRepository.listProfile(workspaceId, userId), contextRepository.searchMemory(workspaceId, userId, "work")]);
  assert.equal(profile.length, 2);
  const composed = composeTurnContext({
    now: new Date(),
    timezone: "Europe/Kyiv",
    tasks: [],
    tasksTotal: 0,
    truncated: false,
    occurrencesByTask: new Map(),
    goals: [],
    taskGoalLinks: [],
    profile,
    memoryMatches,
    settings: null,
    topics: [],
  });
  const serialized = JSON.stringify(composed.model);
  assert.match(serialized, /Usually plans important work before noon/);
  assert.doesNotMatch(serialized, /Private medical detail/);
  assert.equal(composed.model.memory.length, 1);
});

test("an invite creates one isolated personal workspace and cannot be reused", async () => {
  const ownerTelegramId = ++telegramUserSequence;
  const ownerId = await access.addUser(ownerTelegramId);
  const invite = await access.createRegistrationInvite(ownerId, new Date("2026-08-12T09:00:00Z"));

  const existingAttempt = await access.registerFromInvite(invite.token, ownerTelegramId, new Date("2026-08-12T09:01:00Z"));
  assert.equal(existingAttempt.kind, "already_registered");

  const newTelegramId = ++telegramUserSequence;
  const registration = await access.registerFromInvite(invite.token, newTelegramId, new Date("2026-08-12T09:05:00Z"));
  assert.equal(registration.kind, "created");

  const joined = await access.resolveActiveUser(newTelegramId);
  const owner = await access.resolveActiveUser(ownerTelegramId);
  assert.ok(joined);
  assert.ok(owner);
  assert.notEqual(joined.workspaceId, owner.workspaceId);
  assert.notEqual(joined.user.id, owner.user.id);
  assert.ok((await database.db.select().from(userSettings).where(eq(userSettings.userId, joined.user.id))).length);

  const secondAttempt = await access.registerFromInvite(invite.token, ++telegramUserSequence, new Date("2026-08-12T09:06:00Z"));
  assert.equal(secondAttempt.kind, "invalid");

  const expiredToken = "E".repeat(43);
  await database.pool.query("insert into registration_invites(token, created_by_user_id, created_at, expires_at) values ($1, $2, $3, $4)", [
    expiredToken,
    ownerId,
    new Date("2026-07-25T09:00:00Z"),
    new Date("2026-08-01T09:00:00Z"),
  ]);
  const expiredAttempt = await access.registerFromInvite(expiredToken, ++telegramUserSequence, new Date("2026-08-12T09:06:00Z"));
  assert.equal(expiredAttempt.kind, "invalid");
});

test("a user from another personal workspace cannot create an action group in it", async () => {
  const owner = await fixture();
  const other = await fixture();
  await assert.rejects(actions.createImmediateGroup({ id: randomUUID(), workspaceId: owner.workspaceId, actorUserId: other.userId }), (error) => {
    assert.match(error.cause?.message ?? "", /foreign key|workspace_members|violates/i);
    return true;
  });
});

test("a rewritten checklist keeps the ticks the user already made, and clear empties a field", async () => {
  const { workspaceId, userId } = await fixture();
  const taskId = randomUUID();
  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone, fuzzy_horizon_text, review_at, next_action) values ($1,$2,$3,'Разобраться с налогами','task','normal','active','fuzzy','Europe/Kyiv','к осени',now(),'Скачать выписки')",
    [taskId, workspaceId, userId],
  );
  const items = ["Скачать выписки", "Собрать чеки", "Заполнить декларацию"];
  for (const [index, text] of items.entries()) {
    await database.pool.query("insert into task_checklist_items(id, workspace_id, task_id, text, done, sort_order) values ($1,$2,$3,$4,$5,$6)", [
      randomUUID(),
      workspaceId,
      taskId,
      text,
      index === 0,
      index,
    ]);
  }

  // The model restates the steps and adds one; the tick on the first must survive.
  await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId: randomUUID(),
    groupExists: false,
    now: new Date(),
    undoExpiresAt: new Date(Date.now() + 60_000),
    steps: [
      {
        kind: "update_task",
        taskId,
        expectedVersion: 1,
        patch: { checklist: [...items, "Отправить в налоговую"].map((text) => ({ text, done: false })) },
      },
    ],
  });
  const after = await database.pool.query("select text, done from task_checklist_items where task_id=$1 order by sort_order", [taskId]);
  assert.deepEqual(
    after.rows.map((row) => [row.text, row.done]),
    [
      ["Скачать выписки", true],
      ["Собрать чеки", false],
      ["Заполнить декларацию", false],
      ["Отправить в налоговую", false],
    ],
  );

  // «не дроби»: the steps and the next action are emptied, which `null` in a patch cannot express.
  const version = (await database.pool.query("select version from tasks where id=$1", [taskId])).rows[0].version;
  await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId: randomUUID(),
    groupExists: false,
    now: new Date(),
    undoExpiresAt: new Date(Date.now() + 60_000),
    steps: [{ kind: "update_task", taskId, expectedVersion: version, patch: { nextAction: null, checklist: [] } }],
  });
  assert.equal((await database.pool.query("select next_action from tasks where id=$1", [taskId])).rows[0].next_action, null);
  assert.equal((await database.pool.query("select count(*)::int as count from task_checklist_items where task_id=$1", [taskId])).rows[0].count, 0);
});

test("the week pool: a pick is toggled, capped at seven, and only counts for the week it names", async () => {
  const { workspaceId, userId } = await fixture();
  const service = new TasksService(new TasksRepository(database), { enqueue: async () => undefined }, {});
  const today = "2026-09-09"; // Wednesday; its week starts on the 7th.
  const created = [];
  for (let index = 0; index < 8; index += 1) created.push((await createFuzzyTask(workspaceId, userId, `Пул ${index}`)).taskId);

  const plan = await service.listWeekPlanForTelegram(workspaceId, today);
  assert.equal(plan.total, 8);
  assert.equal(plan.weekStart, "2026-09-07");
  assert.equal(plan.rows.length, 8);

  for (const taskId of created.slice(0, 7)) assert.equal(await service.togglePickedForWeek(workspaceId, taskId, today), "picked");
  // The eighth does not fit and nothing is written for it.
  assert.equal(await service.togglePickedForWeek(workspaceId, created[7], today), "full");
  assert.equal((await service.listPickedForWeek(workspaceId, today)).length, 7);
  const untouched = await database.pool.query("select picked_week_start from tasks where id=$1", [created[7]]);
  assert.equal(untouched.rows[0].picked_week_start, null);

  // The same tap releases it, so no separate undo is needed.
  assert.equal(await service.togglePickedForWeek(workspaceId, created[0], today), "released");
  assert.equal((await service.listPickedForWeek(workspaceId, today)).length, 6);

  // A mark from last week is not this week's plan, and it leads the pick screen as unfinished work.
  await database.pool.query("update tasks set picked_week_start='2026-08-31' where id=$1", [created[0]]);
  assert.equal((await service.listPickedForWeek(workspaceId, today)).length, 6);
  const withLeftover = await service.listWeekPlanForTelegram(workspaceId, today);
  assert.equal(withLeftover.rows[0].id, created[0]);
  assert.equal(withLeftover.summary.takenNotStarted, 1, "the previous week's pick that never got a day");

  // A task that left the pool cannot be picked at all.
  await database.pool.query("update tasks set time_mode='point', planned_start_at=now(), fuzzy_horizon_text=null where id=$1", [created[1]]);
  assert.equal(await service.togglePickedForWeek(workspaceId, created[1], today), null);
  assert.equal(await service.togglePickedForWeek(workspaceId, randomUUID(), today), null);
});

test("the journal and Undo tell the truth about checklist ticks", async () => {
  const { workspaceId, userId } = await fixture();
  const taskId = randomUUID();
  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone, planned_start_at) values ($1,$2,$3,'Налоги','task','normal','active','point','Europe/Kyiv',now())",
    [taskId, workspaceId, userId],
  );
  const items = ["Собрать документы", "Заполнить декларацию"];
  for (const [index, text] of items.entries()) {
    await database.pool.query("insert into task_checklist_items(id, workspace_id, task_id, text, done, sort_order) values ($1,$2,$3,$4,$5,$6)", [
      randomUUID(),
      workspaceId,
      taskId,
      text,
      index === 0,
      index,
    ]);
  }
  const groupId = randomUUID();
  const applied = await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now: new Date(),
    undoExpiresAt: new Date(Date.now() + 60_000),
    steps: [{ kind: "update_task", taskId, expectedVersion: 1, patch: { checklist: [...items, "Отправить"].map((text) => ({ text, done: false })) } }],
  });
  // The tick survived, so the journal and the report must say so: telling the user "0/3" while the
  // row holds one done item is a lie the applied report is there to prevent.
  const [step] = applied.steps;
  const change = step.changes.find((item) => item.field === "checklist");
  assert.equal(change.after, "checklist:3:1", "three items, the tick kept");
  const [event] = await database.db
    .select()
    .from(actionEvents)
    .where(and(eq(actionEvents.groupId, groupId), eq(actionEvents.actionType, "update_task")));
  assert.deepEqual(
    event.afterState.checklist.map((item) => [item.text, item.done]),
    [
      ["Собрать документы", true],
      ["Заполнить декларацию", false],
      ["Отправить", false],
    ],
  );

  // Undo restores what was recorded, ticks included — it must not re-apply the "keep progress" merge.
  await database.pool.query("update task_checklist_items set done=true where task_id=$1 and text='Заполнить декларацию'", [taskId]);
  assert.ok(await actions.claimUndo(workspaceId, userId, groupId, new Date()));
  await groups.undo({ workspaceId, groupId, now: new Date() });
  const restored = await database.pool.query("select text, done from task_checklist_items where task_id=$1 order by sort_order", [taskId]);
  assert.deepEqual(
    restored.rows.map((row) => [row.text, row.done]),
    [
      ["Собрать документы", true],
      ["Заполнить декларацию", false],
    ],
    "undo un-ticks what it recorded as unticked",
  );
});

test("cancelling a dated task writes the task once", async () => {
  const { workspaceId, userId } = await fixture();
  const { taskId } = await createOccurrence(workspaceId, userId);
  const groupId = randomUUID();
  await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now: new Date(),
    undoExpiresAt: new Date(Date.now() + 60_000),
    steps: [{ kind: "cancel_task", taskId, expectedVersion: 1 }],
  });
  const task = (await database.pool.query("select status, version from tasks where id=$1", [taskId])).rows[0];
  assert.equal(task.status, "cancelled");
  assert.equal(task.version, 2, "one action is one version bump");
  const events = await database.db
    .select()
    .from(actionEvents)
    .where(and(eq(actionEvents.groupId, groupId), eq(actionEvents.entityType, "task")));
  assert.equal(events.length, 1, "and one journal row for the task");
});

test("a task given a day leaves the week pool, so the cap and the summary stay honest", async () => {
  const { workspaceId, userId } = await fixture();
  const service = new TasksService(new TasksRepository(database), { enqueue: async () => undefined }, {});
  const today = "2026-09-09";
  const created = [];
  for (let index = 0; index < 7; index += 1) created.push((await createFuzzyTask(workspaceId, userId, `Пул ${index}`)).taskId);
  for (const taskId of created) assert.equal(await service.togglePickedForWeek(workspaceId, taskId, today), "picked");

  // Giving one of them a day is what «делаю сегодня» does.
  const version = (await database.pool.query("select version from tasks where id=$1", [created[0]])).rows[0].version;
  await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId: randomUUID(),
    groupExists: false,
    now: new Date(),
    undoExpiresAt: new Date(Date.now() + 60_000),
    steps: [
      {
        kind: "concretise_task",
        taskId: created[0],
        expectedVersion: version,
        definition: { kind: "task", importance: "normal", timeMode: "window", timezone: "Europe/Kyiv", plannedLocalDate: today },
        occurrenceStatus: "open",
      },
    ],
  });
  assert.equal((await database.pool.query("select picked_week_start from tasks where id=$1", [created[0]])).rows[0].picked_week_start, null);
  assert.equal((await service.listPickedForWeek(workspaceId, today)).length, 6, "the task that got a day is no longer waiting for one");
  const plan = await service.listWeekPlanForTelegram(workspaceId, today);
  assert.equal(plan.summary.takenNotStarted, 0, "a task that did get a day is not «taken and never started»");

  // The freed slot can be filled, and the cap still holds at seven.
  const extra = (await createFuzzyTask(workspaceId, userId, "Ещё одна")).taskId;
  assert.equal(await service.togglePickedForWeek(workspaceId, extra, today), "picked");
  const another = (await createFuzzyTask(workspaceId, userId, "И ещё")).taskId;
  assert.equal(await service.togglePickedForWeek(workspaceId, another, today), "full");
  assert.equal((await service.listPickedForWeek(workspaceId, today)).length, 7);
});

test("two taps arriving together cannot both take the last slot", async () => {
  const { workspaceId, userId } = await fixture();
  const service = new TasksService(new TasksRepository(database), { enqueue: async () => undefined }, {});
  const today = "2026-09-09";
  for (let index = 0; index < 6; index += 1) {
    const { taskId } = await createFuzzyTask(workspaceId, userId, `Занято ${index}`);
    await service.togglePickedForWeek(workspaceId, taskId, today);
  }
  const first = (await createFuzzyTask(workspaceId, userId, "Первый")).taskId;
  const second = (await createFuzzyTask(workspaceId, userId, "Второй")).taskId;
  const results = await Promise.all([service.togglePickedForWeek(workspaceId, first, today), service.togglePickedForWeek(workspaceId, second, today)]);
  assert.deepEqual(results.filter((result) => result === "picked").length, 1, `one pick and one refusal, got ${results.join("/")}`);
  assert.equal((await service.listPickedForWeek(workspaceId, today)).length, 7);
});

test("the weekly summary counts what closed inside the previous local week", async () => {
  const { workspaceId, userId } = await fixture();
  const service = new TasksService(new TasksRepository(database), { enqueue: async () => undefined }, {});
  const taskId = randomUUID();
  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone, planned_start_at) values ($1,$2,$3,'Отчёт','task','normal','active','point','Europe/Kyiv',now())",
    [taskId, workspaceId, userId],
  );
  const insertDone = async (completedAt) => {
    await database.pool.query(
      "insert into task_occurrences(id, workspace_id, task_id, status, timezone, planned_start_at, completed_at) values ($1,$2,$3,'done','Europe/Kyiv',$4,$4)",
      [randomUUID(), workspaceId, taskId, completedAt],
    );
  };
  // Monday of the previous week, its Sunday, and a day outside it.
  await insertDone(new Date("2026-08-31T09:00:00Z"));
  await insertDone(new Date("2026-09-06T20:00:00Z"));
  await insertDone(new Date("2026-09-07T09:00:00Z"));

  const plan = await service.listWeekPlanForTelegram(workspaceId, "2026-09-09");
  assert.equal(plan.summary.done, 2);
});

test("an explicit reminder on a new task is persisted instead of the default one", async () => {
  // Production 2026-08-23: "напомни за полчаса" stored only the default planned_start reminder.
  const { workspaceId, userId } = await fixture();
  const enqueued = [];
  const tasksService = new TasksService(
    new TasksRepository(database),
    {
      enqueue: async (id, at) => {
        enqueued.push({ id, at });
      },
    },
    {},
  );
  const now = new Date("2026-08-23T07:04:40Z");
  const result = await tasksService.createTask({
    workspaceId,
    actorUserId: userId,
    recipientUserId: userId,
    title: "Вакцинация",
    now,
    definition: { kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv", plannedStartAt: new Date("2026-08-23T15:00:00Z") },
    explicitReminder: { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -1800, purpose: "user_reminder", quietPolicy: "respect", origin: "explicit" },
  });
  const rules = (
    await database.pool.query("select anchor, offset_seconds, purpose, origin from reminder_rules where task_id=$1 and active order by offset_seconds", [result.taskId])
  ).rows;
  assert.deepEqual(rules, [{ anchor: "planned_start", offset_seconds: -1800, purpose: "user_reminder", origin: "explicit" }]);
  const deliveries = (await database.pool.query("select scheduled_for, status from reminder_deliveries where task_id=$1", [result.taskId])).rows;
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, "pending");
  assert.equal(new Date(deliveries[0].scheduled_for).toISOString(), "2026-08-23T14:30:00.000Z");
  assert.equal(result.reminderSchedules[0]?.scheduledFor.toISOString(), "2026-08-23T14:30:00.000Z");
  assert.equal(enqueued.length, 1);
});

test("cancelling a task closes the task itself, not only the date in front of it", async () => {
  const { workspaceId, userId } = await fixture();
  const { taskId, occurrenceId } = await createOccurrence(workspaceId, userId);
  const groupId = randomUUID();
  const now = new Date();

  const applied = await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now,
    undoExpiresAt: new Date(now.getTime() + 60_000),
    steps: [{ kind: "cancel_task", taskId, expectedVersion: 1 }],
  });
  assert.equal(applied.steps[0].kind, "cancel_task");

  let [task] = await database.db.select().from(tasks).where(eq(tasks.id, taskId));
  let [occurrence] = await database.db.select().from(taskOccurrences).where(eq(taskOccurrences.id, occurrenceId));
  assert.equal(task?.status, "cancelled", "the task row must not stay active, or it keeps showing in lists and context");
  assert.equal(occurrence?.status, "cancelled");

  // Undo restores both halves of the same step.
  const claimed = await actions.claimUndo(workspaceId, userId, groupId, new Date(now.getTime() + 1_000));
  assert.ok(claimed);
  await groups.undo({ workspaceId, groupId, now: new Date(now.getTime() + 2_000) });
  [task] = await database.db.select().from(tasks).where(eq(tasks.id, taskId));
  [occurrence] = await database.db.select().from(taskOccurrences).where(eq(taskOccurrences.id, occurrenceId));
  assert.equal(task?.status, "active");
  assert.equal(occurrence?.status, "open");
});

test("an occurrence-only group locks the task it belongs to, so two crossing groups cannot deadlock", async () => {
  // The occurrence pass used to reach the task row through a join, after the task pass had already
  // taken its own rows. Two groups naming one task and the other's occurrence then took the same
  // two task rows in opposite orders. The owner is locked in the task pass now, so this apply
  // waits for a task row held by someone else instead of grabbing it in the wrong order.
  const { workspaceId, userId } = await fixture();
  const { taskId, occurrenceId } = await createOccurrence(workspaceId, userId);
  await database.pool.query("update tasks set recurrence_rule='FREQ=DAILY', recurrence_timezone='Europe/Kyiv' where id=$1", [taskId]);
  const blocker = await database.pool.connect();
  try {
    await blocker.query("begin");
    await blocker.query("select id from tasks where id=$1 for update", [taskId]);
    const now = new Date();
    const apply = groups.apply({
      workspaceId,
      actorUserId: userId,
      groupId: randomUUID(),
      groupExists: false,
      now,
      undoExpiresAt: new Date(now.getTime() + 60_000),
      steps: [{ kind: "update_occurrence", occurrenceId, expectedVersion: 1, operation: "skip" }],
    });
    const raced = await Promise.race([apply.then(() => "applied"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 700))]);
    assert.equal(raced, "waiting", "the apply must be waiting for the task row the other transaction holds");
    await blocker.query("rollback");
    await apply;
    const [occurrence] = await database.db.select().from(taskOccurrences).where(eq(taskOccurrences.id, occurrenceId));
    assert.equal(occurrence?.status, "skipped");
  } finally {
    await blocker.query("rollback").catch(() => undefined);
    blocker.release();
  }
});

test("a one-off whose day has passed joins the pool instead of hanging overdue forever", async () => {
  // There is no terminal transition for a missed one-off: it stays overdue until the user acts.
  // The pool is where a task's day is chosen, so that is where it waits, keeping its old date.
  const { workspaceId, userId } = await fixture();
  const service = new TasksService(new TasksRepository(database), { enqueue: async () => undefined }, {});
  const today = "2026-09-09";
  const { taskId, occurrenceId } = await createOccurrence(workspaceId, userId);
  await database.pool.query("update task_occurrences set overdue=true where id=$1", [occurrenceId]);

  const plan = await service.listWeekPlanForTelegram(workspaceId, today);
  assert.deepEqual(
    plan.rows.map((row) => row.id),
    [taskId],
  );
  assert.equal(plan.rows[0].overdue, true);

  // It is taken for the week like any other pool task.
  assert.equal(await service.togglePickedForWeek(workspaceId, taskId, today), "picked");
  assert.deepEqual(
    (await service.listPickedForWeek(workspaceId, today)).map((task) => task.id),
    [taskId],
  );

  // A series stays out: its next date comes on its own, and a missed one is not a decision.
  await database.pool.query("update tasks set recurrence_rule='FREQ=DAILY', recurrence_timezone='Europe/Kyiv' where id=$1", [taskId]);
  assert.equal((await service.listWeekPlanForTelegram(workspaceId, today)).total, 0);

  // Finishing it takes it out of the pool without any clearing job.
  await database.pool.query("update tasks set recurrence_rule=null where id=$1", [taskId]);
  await database.pool.query("update task_occurrences set status='done' where id=$1", [occurrenceId]);
  assert.equal((await service.listWeekPlanForTelegram(workspaceId, today)).total, 0);
});

test("a task with no day can carry its own reminder, and Undo takes it back", async () => {
  // Every reminder path was keyed by an occurrence, so `set_reminder` on a dateless task refused —
  // even though creation puts an explicit reminder on the task row and the planning review already
  // steps aside for it. The rule lands on the task; the fuzzy rebuild plans its delivery.
  const { workspaceId, userId } = await fixture();
  const { taskId } = await createFuzzyTask(workspaceId, userId, "Разобраться с налогами");
  const version = (await database.pool.query("select version from tasks where id=$1", [taskId])).rows[0].version;
  const exactAt = new Date(Date.now() + 2 * 86_400_000);
  const groupId = randomUUID();
  const now = new Date();

  const applied = await groups.apply({
    workspaceId,
    actorUserId: userId,
    groupId,
    groupExists: false,
    now,
    undoExpiresAt: new Date(now.getTime() + 60_000),
    steps: [
      {
        kind: "change_task_reminder",
        taskId,
        expectedVersion: version,
        mode: "add",
        rule: { triggerKind: "exact", exactAt, purpose: "user_reminder", quietPolicy: "respect", origin: "explicit" },
      },
    ],
  });
  assert.deepEqual(applied.fuzzyRebuildTaskIds, [taskId], "the fuzzy rebuild has to run for the delivery to exist");
  const rules = await database.pool.query("select id, trigger_kind, exact_at, purpose, origin, active, occurrence_id from reminder_rules where task_id=$1 and origin='explicit'", [
    taskId,
  ]);
  assert.equal(rules.rows.length, 1);
  assert.equal(rules.rows[0].occurrence_id, null, "a dateless task keeps its reminder on the task row");
  assert.equal(rules.rows[0].active, true);
  assert.equal(new Date(rules.rows[0].exact_at).getTime(), exactAt.getTime());

  // The report says what was saved, and the journal can reverse it.
  const claimed = await actions.claimUndo(workspaceId, userId, groupId, new Date(now.getTime() + 1_000));
  assert.ok(claimed);
  const undone = await groups.undo({ workspaceId, groupId, now: new Date(now.getTime() + 2_000) });
  assert.deepEqual(undone.fuzzyRebuildTaskIds, [taskId]);
  assert.equal((await database.pool.query("select count(*)::int as count from reminder_rules where task_id=$1 and origin='explicit'", [taskId])).rows[0].count, 0);
});

test("the fuzzy rebuild plans the delivery of a reminder that hangs on the task", async () => {
  const { workspaceId, userId } = await fixture();
  const { taskId } = await createFuzzyTask(workspaceId, userId, "Записаться к врачу");
  const ruleId = randomUUID();
  const exactAt = new Date(Date.now() + 2 * 86_400_000);
  await database.pool.query(
    "insert into reminder_rules(id, workspace_id, task_id, trigger_kind, exact_at, purpose, quiet_policy, origin, active) values ($1,$2,$3,'exact',$4,'user_reminder','respect','explicit',true)",
    [ruleId, workspaceId, taskId, exactAt],
  );
  const enqueued = [];
  const scheduling = new ReminderSchedulingService(database, { enqueue: async (id, at) => enqueued.push({ id, at }) });

  await scheduling.rebuildFuzzyTask(workspaceId, userId, taskId, new Date());
  const deliveries = await database.pool.query("select reminder_rule_id, status, scheduled_for, occurrence_id from reminder_deliveries where reminder_rule_id=$1", [ruleId]);
  assert.equal(deliveries.rows.length, 1);
  assert.equal(deliveries.rows[0].status, "pending");
  assert.equal(deliveries.rows[0].occurrence_id, null);
  assert.equal(new Date(deliveries.rows[0].scheduled_for).getTime(), exactAt.getTime());
  assert.ok(enqueued.some((job) => job.at.getTime() === exactAt.getTime()));

  // Running again plans nothing new: the rule already has its delivery.
  await scheduling.rebuildFuzzyTask(workspaceId, userId, taskId, new Date());
  assert.equal((await database.pool.query("select count(*)::int as count from reminder_deliveries where reminder_rule_id=$1", [ruleId])).rows[0].count, 1);
});
