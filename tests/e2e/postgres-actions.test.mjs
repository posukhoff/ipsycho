import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../dist/database/database.service.js";
import { ActionsRepository } from "../../dist/actions/actions.repository.js";
import { ContextActionsRepository } from "../../dist/context/context-actions.repository.js";
import { ContextRepository } from "../../dist/context/context.repository.js";
import { ContextService } from "../../dist/context/context.service.js";
import { AccessService } from "../../dist/access/access.service.js";
import { actionEvents, memoryItems } from "../../dist/database/schema.js";
import { and, eq } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required; run npm run test:e2e");

const database = new DatabaseService({ databaseUrl: url });
const actions = new ActionsRepository(database);
const contextActions = new ContextActionsRepository(database);
const contextRepository = new ContextRepository(database);
const context = new ContextService(contextRepository);
const access = new AccessService(database);
let telegramUserSequence = Date.now();

async function fixture() {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  telegramUserSequence += 1;
  await database.pool.query("insert into users(id, telegram_user_id) values ($1, $2)", [userId, BigInt(telegramUserSequence)]);
  await database.pool.query("insert into workspaces(id, owner_user_id) values ($1, $2)", [workspaceId, userId]);
  await database.pool.query("insert into workspace_members(workspace_id, user_id, role) values ($1, $2, 'owner')", [workspaceId, userId]);
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

test("the E2E database includes every migration required by the running schema", async () => {
  const { rows } = await database.pool.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'user_settings' and column_name = 'profile_invited_at'",
  );
  assert.deepEqual(rows.map((row) => row.column_name), ["profile_invited_at"]);
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
