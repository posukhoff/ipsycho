import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../dist/database/database.service.js";
import { BriefingContentService } from "../../dist/briefings/briefing-content.service.js";
import { ContextService } from "../../dist/context/context.service.js";
import { ContextRepository } from "../../dist/context/context.repository.js";
import { BriefingSchedulingService } from "../../dist/briefings/briefing-scheduling.service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required; run npm run test:e2e");

const database = new DatabaseService({ databaseUrl: url });
const context = new ContextService(new ContextRepository(database));
const content = new BriefingContentService(database, context);
const TIMEZONE = "Europe/Kyiv";
let telegramUserSequence = Date.now() + 5_000;

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

async function poolTask({ workspaceId, userId }, title, pickedWeekStart = null) {
  const taskId = randomUUID();
  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone, fuzzy_horizon_text, review_at, picked_week_start) values ($1,$2,$3,$4,'task','normal','active','fuzzy',$5,'на неделе',now(),$6)",
    [taskId, workspaceId, userId, title, TIMEZONE, pickedWeekStart],
  );
  return taskId;
}

async function scheduledTask({ workspaceId, userId }, title, localDate) {
  const taskId = randomUUID();
  await database.pool.query(
    "insert into tasks(id, workspace_id, created_by_user_id, title, kind, importance, status, time_mode, timezone, planned_local_date) values ($1,$2,$3,$4,'task','required','active','window',$5,$6)",
    [taskId, workspaceId, userId, title, TIMEZONE, localDate],
  );
  await database.pool.query("insert into task_occurrences(id, workspace_id, task_id, status, timezone, planned_local_date) values ($1,$2,$3,'open',$4,$5)", [
    randomUUID(),
    workspaceId,
    taskId,
    TIMEZONE,
    localDate,
  ]);
  return taskId;
}

beforeEach(async () => {
  await database.pool.query("truncate table users cascade");
});

after(async () => {
  await database.onApplicationShutdown();
});

test("the morning card lists the day, then what was taken for the week, and offers those as taps", async () => {
  const scope = await fixture();
  const localDate = "2026-09-09"; // Wednesday of the week starting on the 7th.
  await scheduledTask(scope, "Отчёт по проекту", localDate);
  const takenId = await poolTask(scope, "Разобраться с налогами", "2026-09-07");
  await poolTask(scope, "Привести в порядок машину", null);
  await poolTask(scope, "Старая метка", "2026-08-31");

  const built = await content.build({ workspaceId: scope.workspaceId, kind: "morning", localDate, timezone: TIMEZONE, locale: "ru" });

  assert.match(built.text, /Отчёт по проекту/);
  assert.match(built.text, /Взято на неделю:/);
  assert.match(built.text, /Разобраться с налогами/);
  assert.doesNotMatch(built.text, /Привести в порядок машину/, "the pool is not the plan; only what was taken is listed");
  assert.doesNotMatch(built.text, /Старая метка/, "a mark from an earlier week is not this week's plan");
  assert.deepEqual(
    built.weekTasks.map((task) => task.id),
    [takenId],
  );
});

test("a day with nothing scheduled still shows what was taken for the week", async () => {
  const scope = await fixture();
  await poolTask(scope, "Подготовиться к собеседованию", "2026-09-07");
  const built = await content.build({ workspaceId: scope.workspaceId, kind: "morning", localDate: "2026-09-09", timezone: TIMEZONE, locale: "ru" });
  assert.equal(built.hasContent, true);
  assert.match(built.text, /Подготовиться к собеседованию/);
  assert.equal(built.weekTasks.length, 1);

  const empty = await fixture();
  const nothing = await content.build({ workspaceId: empty.workspaceId, kind: "morning", localDate: "2026-09-09", timezone: TIMEZONE, locale: "ru" });
  assert.equal(nothing.hasContent, false);
  assert.deepEqual(nothing.weekTasks, []);
});

test("the weekly card reports the past week and points at the pool instead of starting a conversation", async () => {
  const scope = await fixture();
  const doneTaskId = await scheduledTask(scope, "Закрытое дело", "2026-09-02");
  await database.pool.query("update task_occurrences set status='done', completed_at=$2 where task_id=$1", [doneTaskId, new Date("2026-09-03T09:00:00Z")]);
  await poolTask(scope, "Взято и не начато", "2026-08-31");
  await poolTask(scope, "Просто в пуле", null);

  const built = await content.build({ workspaceId: scope.workspaceId, kind: "weekly", localDate: "2026-09-09", timezone: TIMEZONE, locale: "ru" });

  assert.match(built.text, /План недели/);
  assert.match(built.text, /закрыто: 1/);
  assert.match(built.text, /не начато: 1/);
  assert.match(built.text, /\/week/);
  assert.deepEqual(built.reviewKinds, [], "the weekly delivery no longer opens a review conversation");
});

test("the weekly card says the pool is empty instead of inviting a pick", async () => {
  const scope = await fixture();
  const built = await content.build({ workspaceId: scope.workspaceId, kind: "weekly", localDate: "2026-09-09", timezone: TIMEZONE, locale: "en" });
  assert.match(built.text, /pool has no undated tasks/);
  assert.doesNotMatch(built.text, /\/week/);
});

test("an overdue task stays in every morning card until it is dealt with", async () => {
  // A missed one-off has no terminal transition and the day it names is not today, so the card
  // reads it as today's business (`occurrenceFallsOnLocalDate` is true for overdue work) and says
  // so on the line. What it cannot do is offer a new day — that is what the week pool is for.
  const scope = await fixture();
  await scheduledTask(scope, "Позвонить в банк", "2026-09-01");
  await database.pool.query("update task_occurrences set overdue=true");
  await scheduledTask(scope, "Забрать посылку", "2026-09-07");

  const card = await content.build({ workspaceId: scope.workspaceId, kind: "morning", localDate: "2026-09-07", timezone: TIMEZONE, now: new Date("2026-09-07T06:00:00Z") });
  assert.match(card.text, /Забрать посылку/u);
  assert.match(card.text, /Позвонить в банк · просрочено/u);

  // A day with nothing planned of its own still carries it.
  const later = await content.build({ workspaceId: scope.workspaceId, kind: "morning", localDate: "2026-09-08", timezone: TIMEZONE, now: new Date("2026-09-08T06:00:00Z") });
  assert.match(later.text, /Позвонить в банк · просрочено/u);
  assert.equal(later.hasContent, true);

  // Done is done: it leaves the card with no clearing job.
  await database.pool.query("update task_occurrences set status='done', completed_at=now() where overdue");
  const cleared = await content.build({ workspaceId: scope.workspaceId, kind: "morning", localDate: "2026-09-08", timezone: TIMEZONE, now: new Date("2026-09-08T06:00:00Z") });
  assert.equal(/Позвонить в банк/u.test(cleared.text), false);
});

test("a card is not first created for an hour that has already passed, so enabling it in the evening does not fire it", async () => {
  const scope = await fixture();
  await database.pool.query("update user_settings set morning_digest_enabled=true, morning_reference_time='09:00', digest_timezone=$2 where user_id=$1", [scope.userId, TIMEZONE]);
  const enqueued = [];
  const scheduling = new BriefingSchedulingService(database, { enqueue: async (id, at) => enqueued.push({ id, at }) });
  const rows = async () =>
    (
      await database.pool.query("select local_date::text as local_date, status, scheduled_for from briefing_deliveries where recipient_user_id=$1 order by local_date", [
        scope.userId,
      ])
    ).rows;

  // 21:00 in Kyiv: today's 09:00 slot is twelve hours gone.
  await scheduling.reconcile(new Date("2026-09-07T18:00:00Z"));
  assert.deepEqual(
    (await rows()).map((row) => row.local_date),
    ["2026-09-08"],
    "only tomorrow's card is created",
  );

  // The same slot one minute after its time is this loop catching up, not a stale card.
  await scheduling.reconcile(new Date("2026-09-08T06:01:00Z"));
  assert.deepEqual(
    (await rows()).map((row) => row.local_date),
    ["2026-09-08", "2026-09-09"],
  );
  assert.equal(enqueued.length, 3);

  // A row that already exists keeps the wider grace: a card missed while the process was down still goes out.
  await database.pool.query("update briefing_deliveries set status='pending' where local_date='2026-09-08'");
  await scheduling.reconcile(new Date("2026-09-08T09:00:00Z"));
  const kept = (await rows()).find((row) => row.local_date === "2026-09-08");
  assert.equal(kept.status, "pending");
});

async function goal(scope, title, { idleDays = 0, reviewEnabled = true, status = "active" } = {}) {
  const goalId = randomUUID();
  const at = new Date(Date.now() - idleDays * 86_400_000);
  await database.pool.query("insert into goals(id, workspace_id, created_by_user_id, title, status, review_enabled, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$7)", [
    goalId,
    scope.workspaceId,
    scope.userId,
    title,
    status,
    reviewEnabled,
    at,
  ]);
  return goalId;
}

test("the weekly card raises a goal nothing has moved, and a linked task counts as movement", async () => {
  // `goals.review_enabled` was written and never read: a goal could sit untouched for months and
  // nothing in the product ever mentioned it.
  const scope = await fixture();
  const forgotten = await goal(scope, "Запустить платную группу", { idleDays: 40 });
  await goal(scope, "Английский", { idleDays: 3 });
  await goal(scope, "Личное", { idleDays: 90, reviewEnabled: false });

  const card = await content.build({ workspaceId: scope.workspaceId, kind: "weekly", localDate: "2026-09-13", timezone: TIMEZONE, now: new Date() });
  assert.match(card.text, /Цели без движения:/u);
  assert.match(card.text, /🎯 Запустить платную группу — тишина 40 дн\./u);
  assert.equal(/Английский/u.test(card.text), false, "a goal touched three days ago is not silence");
  assert.equal(/Личное/u.test(card.text), false, "review turned off means leave it alone");
  assert.deepEqual(
    card.idleGoals.map((row) => row.id),
    [forgotten],
  );

  // A task linked to the goal and touched today is movement, so the goal goes quiet again.
  const taskId = await poolTask(scope, "Собрать лендинг");
  await database.pool.query("insert into task_goals(workspace_id, task_id, goal_id, source, confidence) values ($1,$2,$3,'user_explicit',1)", [
    scope.workspaceId,
    taskId,
    forgotten,
  ]);
  const after = await content.build({ workspaceId: scope.workspaceId, kind: "weekly", localDate: "2026-09-13", timezone: TIMEZONE, now: new Date() });
  assert.equal(/Цели без движения/u.test(after.text), false);
  assert.deepEqual(after.idleGoals, []);
});
