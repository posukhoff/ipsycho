import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../dist/database/database.service.js";
import { ActionsRepository } from "../../dist/actions/actions.repository.js";
import { ContextActionsRepository } from "../../dist/context/context-actions.repository.js";
import { ContextRepository } from "../../dist/context/context.repository.js";
import { ContextService } from "../../dist/context/context.service.js";
import { ActionMutationsRepository } from "../../dist/actions/action-mutations.repository.js";
import { TaskBatchRepository } from "../../dist/actions/task-batch.repository.js";
import { AccessService } from "../../dist/access/access.service.js";
import { MessagesRepository } from "../../dist/messages/messages.repository.js";
import { TasksRepository } from "../../dist/tasks/tasks.repository.js";
import { TasksService } from "../../dist/tasks/tasks.service.js";
import { actionEvents, actionGroups, conversationTopics, memoryItems, messages, taskEvents, taskOccurrences, userSettings } from "../../dist/database/schema.js";
import { and, eq } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required; run npm run test:e2e");

const database = new DatabaseService({ databaseUrl: url });
const actions = new ActionsRepository(database);
const mutations = new ActionMutationsRepository(database);
const taskBatches = new TaskBatchRepository(database);
const contextActions = new ContextActionsRepository(database);
const contextRepository = new ContextRepository(database);
const context = new ContextService(contextRepository);
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
  await database.pool.query(
    "insert into memory_items(id, workspace_id, user_id, type, content, sensitive, source) values ($1, $2, $3, 'context', $4, false, 'user_explicit')",
    [id, workspaceId, userId, content],
  );
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
  await actions.createImmediateGroup({ id: groupId, workspaceId, actorUserId: userId });
  await contextActions.applyUpdateMemory({
    workspaceId, groupId, actorUserId: userId, memoryId, expectedVersion: 1,
    patch: { content: "Обычно ложусь в 00:30", sensitive: true }, now,
    undoExpiresAt: new Date(now.getTime() + 60_000),
  });

  const [updated] = await database.db.select().from(memoryItems).where(and(eq(memoryItems.workspaceId, workspaceId), eq(memoryItems.id, memoryId)));
  assert.equal(updated?.content, "Обычно ложусь в 00:30");
  assert.equal(updated?.sensitive, true);
  assert.equal(updated?.version, 2);

  const claimed = await actions.claimUndo(workspaceId, userId, groupId, new Date(now.getTime() + 1_000));
  assert.ok(claimed);
  await contextActions.undoContextGroup({ workspaceId, groupId, events: claimed.events, now: new Date(now.getTime() + 2_000) });

  const [restored] = await database.db.select().from(memoryItems).where(and(eq(memoryItems.workspaceId, workspaceId), eq(memoryItems.id, memoryId)));
  assert.equal(restored?.content, "Обычно ложусь в 23:00");
  assert.equal(restored?.sensitive, false);
  assert.equal(restored?.version, 3);
});

test("stale concurrent profile edits cannot both overwrite one fact", async () => {
  const { workspaceId, userId } = await fixture();
  const memoryId = await createMemory(workspaceId, userId);
  const now = new Date();
  const attempt = async (content) => {
    const groupId = randomUUID();
    await actions.createImmediateGroup({ id: groupId, workspaceId, actorUserId: userId });
    return contextActions.applyUpdateMemory({
      workspaceId, groupId, actorUserId: userId, memoryId, expectedVersion: 1,
      patch: { content }, now, undoExpiresAt: new Date(now.getTime() + 60_000),
    });
  };
  const results = await Promise.allSettled([attempt("Ложусь в 23:30"), attempt("Ложусь в 00:30")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const [memory] = await database.db.select().from(memoryItems).where(and(eq(memoryItems.workspaceId, workspaceId), eq(memoryItems.id, memoryId)));
  assert.equal(memory?.version, 2);
});

test("chat settings update is atomic, versioned and undoable", async () => {
  const { workspaceId, userId } = await fixture();
  const groupId = randomUUID();
  const now = new Date("2026-08-12T09:00:00Z");
  await actions.createImmediateGroup({ id: groupId, workspaceId, actorUserId: userId });
  await mutations.applyUpdateSettings({
    workspaceId, groupId, actorUserId: userId, expectedVersion: 1,
    patch: { morningDigestEnabled: true, morningReferenceTime: "08:30" }, now,
    undoExpiresAt: new Date(now.getTime() + 60_000),
  });
  let [settings] = await database.db.select().from(userSettings).where(eq(userSettings.userId, userId));
  assert.equal(settings?.morningDigestEnabled, true);
  assert.equal(settings?.morningReferenceTime, "08:30");
  assert.equal(settings?.version, 2);
  const claimed = await actions.claimUndo(workspaceId, userId, groupId, new Date(now.getTime() + 1_000));
  assert.ok(claimed);
  await mutations.undoMutationGroup({ workspaceId, groupId, events: claimed.events, now: new Date(now.getTime() + 2_000) });
  [settings] = await database.db.select().from(userSettings).where(eq(userSettings.userId, userId));
  assert.equal(settings?.morningDigestEnabled, false);
  assert.equal(settings?.morningReferenceTime, "09:00");
  assert.equal(settings?.version, 3);
});

test("stale chat settings cannot overwrite a newer settings version", async () => {
  const { workspaceId, userId } = await fixture();
  const now = new Date();
  const attempt = async (time) => {
    const groupId = randomUUID();
    await actions.createImmediateGroup({ id: groupId, workspaceId, actorUserId: userId });
    return mutations.applyUpdateSettings({
      workspaceId, groupId, actorUserId: userId, expectedVersion: 1,
      patch: { morningReferenceTime: time }, now, undoExpiresAt: new Date(now.getTime() + 60_000),
    });
  };
  const results = await Promise.allSettled([attempt("08:00"), attempt("08:30")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("weekly review topics satisfy the production database constraint", async () => {
  const { workspaceId, userId } = await fixture();
  const topic = await context.beginWeeklyReview({ workspaceId, userId });
  const [stored] = await database.db.select().from(conversationTopics).where(eq(conversationTopics.id, topic.id));
  assert.equal(stored?.reviewKind, "weekly");
  assert.equal(stored?.status, "active");
  assert.equal(stored?.reviewState?.version, 1);
  const state = await context.mergeWeeklyReviewProgress({
    workspaceId, userId, topicId: topic.id,
    progress: { outcome: { status: "provided", summary: "Пять интервью" }, capacityEnergy: null, risks: null, minimumSuccess: null, commitments: null, conclusionRequested: false },
  });
  assert.equal(state.outcome.summary, "Пять интервью");
});

test("one Telegram message can seed at most one active action group", async () => {
  const { workspaceId, userId } = await fixture();
  const first = await messageRepository.saveOnce({
    workspaceId, userId, role: "user", status: "processing", content: "Создай задачу",
    telegramChatId: telegramUserSequence, telegramMessageId: 42,
  });
  const duplicate = await messageRepository.saveOnce({
    workspaceId, userId, role: "user", status: "processing", content: "Создай задачу",
    telegramChatId: telegramUserSequence, telegramMessageId: 42,
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
  await database.pool.query(
    "insert into task_occurrences(id, workspace_id, task_id, status, timezone, planned_start_at) values ($1,$2,$3,'open','Europe/Kyiv',$4)",
    [occurrenceId, workspaceId, taskId, new Date(Date.now() - 60_000)],
  );
  return { taskId, occurrenceId };
}

test("task-card lifecycle and action journal commit in one transaction and undo cleanly", async () => {
  const { workspaceId, userId } = await fixture();
  const { occurrenceId } = await createOccurrence(workspaceId, userId);
  const groupId = randomUUID();
  const now = new Date();
  await actions.createImmediateGroup({ id: groupId, workspaceId, actorUserId: userId });
  await mutations.applyUpdateOccurrence({
    workspaceId, groupId, actorUserId: userId, occurrenceId, expectedVersion: 1,
    operation: "start", now, undoExpiresAt: new Date(now.getTime() + 60_000),
  });
  let [occurrence] = await database.db.select().from(taskOccurrences).where(eq(taskOccurrences.id, occurrenceId));
  let [group] = await database.db.select().from(actionGroups).where(eq(actionGroups.id, groupId));
  assert.equal(occurrence?.status, "in_progress");
  assert.equal(occurrence?.version, 2);
  assert.equal(group?.status, "applied");
  const claimed = await actions.claimUndo(workspaceId, userId, groupId, new Date(now.getTime() + 1_000));
  assert.ok(claimed);
  await mutations.undoMutationGroup({ workspaceId, groupId, events: claimed.events, now: new Date(now.getTime() + 2_000) });
  [occurrence] = await database.db.select().from(taskOccurrences).where(eq(taskOccurrences.id, occurrenceId));
  assert.equal(occurrence?.status, "open");
  assert.equal(occurrence?.version, 3);
});

test("Seen interaction and its action group commit atomically", async () => {
  const { workspaceId, userId } = await fixture();
  const { occurrenceId } = await createOccurrence(workspaceId, userId);
  const groupId = randomUUID();
  await actions.createImmediateGroup({ id: groupId, workspaceId, actorUserId: userId });
  const result = await mutations.applyOccurrenceInteraction({
    workspaceId, groupId, actorUserId: userId, occurrenceId, expectedVersion: 1, operation: "seen", now: new Date(),
  });
  assert.equal(result.undoable, false);
  const [group] = await database.db.select().from(actionGroups).where(eq(actionGroups.id, groupId));
  const events = await database.db.select().from(taskEvents).where(and(eq(taskEvents.occurrenceId, occurrenceId), eq(taskEvents.eventType, "occurrence:seen")));
  assert.equal(group?.status, "applied");
  assert.equal(events.length, 1);
});

test("only one concurrent confirmation may claim a pending action group", async () => {
  const { workspaceId, userId } = await fixture();
  const groupId = randomUUID();
  await actions.createPendingGroup({
    id: groupId, workspaceId, actorUserId: userId, expiresAt: new Date(Date.now() + 60_000),
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

test("disabled rollout cancels pending task batches and records an audit event", async () => {
  const { workspaceId, userId } = await fixture();
  const groupId = randomUUID();
  await actions.createPendingGroup({
    id: groupId,
    workspaceId,
    actorUserId: userId,
    expiresAt: new Date(Date.now() + 60_000),
    actions: [{ id: randomUUID(), actionType: "task_batch", payload: { type: "task_batch", steps: [] } }],
  });
  assert.equal(await actions.cancelPendingTaskBatches(new Date()), 1);
  assert.equal((await database.pool.query("select status from action_groups where id=$1", [groupId])).rows[0].status, "cancelled");
  assert.equal((await database.pool.query("select id from pending_actions where group_id=$1", [groupId])).rowCount, 0);
  const audit = await database.pool.query("select action_type, after_state from action_events where group_id=$1", [groupId]);
  assert.equal(audit.rows[0].action_type, "task_batch_rollout_cancelled");
  assert.equal(audit.rows[0].after_state.reason, "rollout_disabled");
});

test("the E2E database includes every migration required by the running schema", async () => {
  const { rows } = await database.pool.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'user_settings' and column_name = 'profile_invited_at'",
  );
  assert.deepEqual(rows.map((row) => row.column_name), ["profile_invited_at"]);
  const version = await database.pool.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'user_settings' and column_name = 'version'",
  );
  assert.deepEqual(version.rows.map((row) => row.column_name), ["version"]);
});

test("recurrence exclusions are unique and cannot cross workspace boundaries", async () => {
  const owner = await fixture();
  const other = await fixture();
  const taskId = randomUUID();
  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone, planned_start_at, recurrence_rule, recurrence_timezone, recurrence_end_local_date) values ($1,$2,$3,'Ограниченная серия','task','normal','active','point','Europe/Kyiv','2026-09-01T06:00:00Z','FREQ=DAILY','Europe/Kyiv','2026-09-30')",
    [taskId, owner.workspaceId, owner.userId],
  );
  await database.pool.query(
    "insert into task_recurrence_exclusions(workspace_id, task_id, local_date) values ($1,$2,'2026-09-10')",
    [owner.workspaceId, taskId],
  );
  await assert.rejects(
    database.pool.query(
      "insert into task_recurrence_exclusions(workspace_id, task_id, local_date) values ($1,$2,'2026-09-10')",
      [owner.workspaceId, taskId],
    ),
    (error) => error?.constraint === "task_recurrence_exclusions_pkey",
  );
  await assert.rejects(
    database.pool.query(
      "insert into task_recurrence_exclusions(workspace_id, task_id, local_date) values ($1,$2,'2026-09-11')",
      [other.workspaceId, taskId],
    ),
    (error) => {
      assert.match(error?.constraint ?? "", /task_recurrence_exclusions.*fkey/);
      return true;
    },
  );
});

test("task batch create and goal link commit atomically", async () => {
  const { workspaceId, userId } = await fixture();
  const goalId = randomUUID();
  await database.pool.query("insert into goals(id, workspace_id, created_by_user_id, title) values ($1,$2,$3,'Цель')", [goalId, workspaceId, userId]);
  const makeCreate = (taskId, groupId) => ({
    kind: "create", stepId: "new_task",
    action: {
      operation: "create", stepId: "new_task", source: "user_explicit", confidence: 1, criticalExplicit: false, habitModeExplicit: false,
      title: "Новая задача", why: null, nextAction: null, context: null, checklist: null, goalLink: null,
      definition: { kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv", plannedStartAt: "2026-09-01T06:30:00Z", plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null, fuzzyHorizonText: null, reviewAt: null, recurrenceRule: null, recurrenceTimezone: null, missPolicy: null, habitMode: false, minimumAction: null, desiredAction: null, habitTrigger: null },
    },
    built: {
      plan: {
        task: { id: taskId, workspaceId, createdByUserId: userId, sourceActionGroupId: groupId, title: "Новая задача", kind: "task", importance: "normal", status: "active", timeMode: "point", timezone: "Europe/Kyiv", plannedStartAt: new Date("2026-09-01T06:30:00Z") },
        occurrences: [], reminderRules: [], reminderDeliveries: [], checklist: [], recurrenceExclusions: [],
      },
      result: { taskId, occurrenceIds: [], deliveryIds: [], reminderSchedules: [] },
    },
  });
  const link = { kind: "link", stepId: "link", target: { kind: "created", stepId: "new_task" }, goalId, expectedGoalVersion: 1, source: "user_explicit", confidence: 1 };

  const failedTaskId = randomUUID();
  const failedGroupId = randomUUID();
  await assert.rejects(taskBatches.apply({ workspaceId, actorUserId: userId, groupId: failedGroupId, groupExists: false, steps: [makeCreate(failedTaskId, failedGroupId), link, { ...link, stepId: "duplicate" }], now: new Date(), undoExpiresAt: new Date(Date.now() + 60_000) }));
  assert.equal((await database.pool.query("select id from tasks where id=$1", [failedTaskId])).rowCount, 0);
  assert.equal((await database.pool.query("select id from action_groups where id=$1", [failedGroupId])).rowCount, 0);

  const taskId = randomUUID();
  const groupId = randomUUID();
  const applied = await taskBatches.apply({ workspaceId, actorUserId: userId, groupId, groupExists: false, steps: [makeCreate(taskId, groupId), link], now: new Date(), undoExpiresAt: new Date(Date.now() + 60_000) });
  assert.equal(applied.count, 2);
  assert.equal((await database.pool.query("select task_id from task_goals where workspace_id=$1 and task_id=$2 and goal_id=$3", [workspaceId, taskId, goalId])).rowCount, 1);
  assert.equal((await database.pool.query("select status from action_groups where id=$1 and status='applied'", [groupId])).rowCount, 1);
  const undoClaim = await actions.claimUndo(workspaceId, userId, groupId, new Date());
  assert.ok(undoClaim);
  await taskBatches.undo({ workspaceId, groupId, events: undoClaim.events, now: new Date() });
  assert.equal((await database.pool.query("select id from tasks where id=$1", [taskId])).rowCount, 0);
  assert.equal((await database.pool.query("select status from action_groups where id=$1 and status='undone'", [groupId])).rowCount, 1);

  const changedTaskId = randomUUID();
  const changedGroupId = randomUUID();
  await taskBatches.apply({ workspaceId, actorUserId: userId, groupId: changedGroupId, groupExists: false, steps: [makeCreate(changedTaskId, changedGroupId), link], now: new Date(), undoExpiresAt: new Date(Date.now() + 60_000) });
  await database.pool.query("update tasks set title='Изменено позже', version=version+1 where id=$1", [changedTaskId]);
  const changedClaim = await actions.claimUndo(workspaceId, userId, changedGroupId, new Date());
  assert.ok(changedClaim);
  await assert.rejects(taskBatches.undo({ workspaceId, groupId: changedGroupId, events: changedClaim.events, now: new Date() }), /changed after the batch/);
  assert.equal((await database.pool.query("select title from tasks where id=$1", [changedTaskId])).rows[0].title, "Изменено позже");
});

test("concurrent task batches cannot both apply the same expected task version", async () => {
  const { workspaceId, userId } = await fixture();
  const taskId = randomUUID();
  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone) values ($1,$2,$3,'Исходная','task','normal','active','fuzzy','Europe/Kyiv')",
    [taskId, workspaceId, userId],
  );
  const attempt = (title) => taskBatches.apply({
    workspaceId, actorUserId: userId, groupId: randomUUID(), groupExists: false,
    steps: [{ kind: "update", stepId: "edit", target: { kind: "persisted", taskId, expectedTaskVersion: 1 }, patch: { title } }],
    now: new Date(), undoExpiresAt: new Date(Date.now() + 60_000),
  });
  const results = await Promise.allSettled([attempt("Первый вариант"), attempt("Второй вариант")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const row = (await database.pool.query("select title, version from tasks where id=$1", [taskId])).rows[0];
  assert.ok(["Первый вариант", "Второй вариант"].includes(row.title));
  assert.equal(row.version, 2);
  assert.equal((await database.pool.query("select count(*)::int as count from action_groups where workspace_id=$1 and status='applied'", [workspaceId])).rows[0].count, 1);
});

test("sensitive profile and memory facts never enter the AI context", async () => {
  const { workspaceId, userId } = await fixture();
  await createMemory(workspaceId, userId, "Usually plans important work before noon");
  await database.pool.query(
    "insert into memory_items(id, workspace_id, user_id, type, content, sensitive, source) values ($1, $2, $3, 'context', $4, true, 'user_explicit')",
    [randomUUID(), workspaceId, userId, "Private medical detail"],
  );
  const aiContext = await context.buildAiContext({ workspaceId, userId, query: "work" });
  const serialized = JSON.stringify(aiContext);
  assert.match(serialized, /Usually plans important work before noon/);
  assert.doesNotMatch(serialized, /Private medical detail/);
  assert.equal(aiContext.userProfile.length, 1);
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
  assert.ok(await access.getUserSettings(joined.user.id));

  const secondAttempt = await access.registerFromInvite(invite.token, ++telegramUserSequence, new Date("2026-08-12T09:06:00Z"));
  assert.equal(secondAttempt.kind, "invalid");

  const expiredToken = "E".repeat(43);
  await database.pool.query(
    "insert into registration_invites(token, created_by_user_id, created_at, expires_at) values ($1, $2, $3, $4)",
    [expiredToken, ownerId, new Date("2026-07-25T09:00:00Z"), new Date("2026-08-01T09:00:00Z")],
  );
  const expiredAttempt = await access.registerFromInvite(expiredToken, ++telegramUserSequence, new Date("2026-08-12T09:06:00Z"));
  assert.equal(expiredAttempt.kind, "invalid");
});

test("a user from another personal workspace cannot create an action group in it", async () => {
  const owner = await fixture();
  const other = await fixture();
  await assert.rejects(
    actions.createImmediateGroup({ id: randomUUID(), workspaceId: owner.workspaceId, actorUserId: other.userId }),
    (error) => {
      assert.match(error.cause?.message ?? "", /foreign key|workspace_members|violates/i);
      return true;
    },
  );
});

test("an explicit reminder on a new task is persisted instead of the default one", async () => {
  // Production 2026-08-23: "напомни за полчаса" stored only the default planned_start reminder.
  const { workspaceId, userId } = await fixture();
  const enqueued = [];
  const tasksService = new TasksService(new TasksRepository(database), { enqueue: async (id, at) => { enqueued.push({ id, at }); } }, {});
  const now = new Date("2026-08-23T07:04:40Z");
  const result = await tasksService.createTask({
    workspaceId, actorUserId: userId, recipientUserId: userId, title: "Вакцинация", now,
    definition: { kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv", plannedStartAt: new Date("2026-08-23T15:00:00Z"), habitMode: false },
    explicitReminder: { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -1800, purpose: "user_reminder", quietPolicy: "respect", origin: "explicit" },
  });
  const rules = (await database.pool.query("select anchor, offset_seconds, purpose, origin from reminder_rules where task_id=$1 and active order by offset_seconds", [result.taskId])).rows;
  assert.deepEqual(rules, [{ anchor: "planned_start", offset_seconds: -1800, purpose: "user_reminder", origin: "explicit" }]);
  const deliveries = (await database.pool.query("select scheduled_for, status from reminder_deliveries where task_id=$1", [result.taskId])).rows;
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, "pending");
  assert.equal(new Date(deliveries[0].scheduled_for).toISOString(), "2026-08-23T14:30:00.000Z");
  assert.equal(result.reminderSchedules[0]?.scheduledFor.toISOString(), "2026-08-23T14:30:00.000Z");
  assert.equal(enqueued.length, 1);
});
