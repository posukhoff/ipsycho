import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import "reflect-metadata";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { AccessService } from "../../dist/access/access.service.js";
import { ActionsService } from "../../dist/actions/actions.service.js";
import { AiService } from "../../dist/ai/ai.service.js";
import { ApiIpRateLimiter, ApiUserRateLimiter } from "../../dist/api/auth/rate-limiter.js";
import {
  GoalDetailSchema,
  GoalMutationResponseSchema,
  GoalsResponseSchema,
  PausedSeriesResponseSchema,
  RescheduleOptionsSchema,
  TaskDetailSchema,
  TaskListResponseSchema,
  TaskMutationResponseSchema,
  TodayResponseSchema,
} from "../../dist/api/contracts/index.js";
import { ApiExceptionFilter } from "../../dist/api/http/api-exception.filter.js";
import { WebTasksModule } from "../../dist/api/tasks/web-tasks.module.js";
import { ChatService } from "../../dist/chat/chat.service.js";
import { APP_CONFIG } from "../../dist/config.js";
import { ContextService } from "../../dist/context/context.service.js";
import { filterByScope, groupTaskRows, scopeCounts } from "../../dist/core/task-list-view.js";
import { DatabaseService } from "../../dist/database/database.service.js";
import { JobQueueService } from "../../dist/queue/job-queue.service.js";
import { ReminderSchedulingService } from "../../dist/reminders/reminder-scheduling.service.js";
import { SettingsService } from "../../dist/settings/settings.service.js";
import { TasksService } from "../../dist/tasks/tasks.service.js";
import { TelegramService } from "../../dist/telegram/telegram.service.js";

/**
 * The task and goal endpoints, over a real socket, with the domain services faked.
 *
 * What the fakes deliberately do *not* fake is the part that decides anything: the grouping is the
 * real `groupTaskRows`, the scope counts are the real `scopeCounts`, and every response is parsed
 * against the frozen contract before a single assertion runs. The fakes are two workspaces' worth
 * of rows and a recorder for the writes.
 *
 * That split is what lets this file answer the four questions tasks.md § 2.7 asks and a database
 * test cannot answer any better:
 *
 * - **Workspace isolation.** Every id-addressed route is called with an id that exists in another
 *   workspace, and the answer has to be byte-identical to the answer for an id that never existed.
 * - **Version conflict.** A stale `expectedVersion` is a typed `conflict` carrying the row's own
 *   version, never a 500 and never a silent overwrite.
 * - **The journal.** Every state change is asserted to reach `ActionsService` with the versions the
 *   client read — the action group *is* the journal row, and a write that bypassed it would be a
 *   change the user cannot see and cannot undo.
 * - **Undo.** `POST /undo` reaches `ActionsService.undo` for the group the write handed back, and
 *   the writes that are not truthfully reversible hand back `null` instead.
 */

const BOT_TOKEN = "123456:AA-test-bot-token-not-a-real-one";
const OWNER_TELEGRAM_ID = 4242;
const USER_ID = "1f2e3d4c-5b6a-4798-8899-aabbccddeeff";
const OTHER_USER_ID = "2f2e3d4c-5b6a-4798-8899-aabbccddeeff";
const WORKSPACE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_WORKSPACE_ID = "9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const TIMEZONE = "Europe/Kyiv";

/* --------------------------------------------------------------------- rows */

const ids = {
  taskPoint: "11111111-1111-4111-8111-111111111111",
  occPoint: "11111111-1111-4111-8111-1111111111a1",
  taskSeries: "22222222-2222-4222-8222-222222222222",
  occSeriesOne: "22222222-2222-4222-8222-2222222222a1",
  occSeriesTwo: "22222222-2222-4222-8222-2222222222a2",
  taskFuzzy: "33333333-3333-4333-8333-333333333333",
  taskPaused: "44444444-4444-4444-8444-444444444444",
  foreignTask: "55555555-5555-4555-8555-555555555555",
  foreignOccurrence: "55555555-5555-4555-8555-5555555555a1",
  foreignGoal: "66666666-6666-4666-8666-666666666666",
  goal: "77777777-7777-4777-8777-777777777777",
  unknown: "88888888-8888-4888-8888-888888888888",
};

function task(overrides) {
  return {
    id: randomUUID(),
    workspaceId: WORKSPACE_ID,
    createdByUserId: USER_ID,
    sourceActionGroupId: null,
    title: "Задача",
    why: null,
    nextAction: null,
    context: null,
    kind: "task",
    importance: "normal",
    status: "active",
    timeMode: "point",
    timezone: TIMEZONE,
    plannedStartAt: null,
    plannedEndAt: null,
    plannedLocalDate: null,
    dueAt: null,
    dueLocalDate: null,
    fuzzyHorizonText: null,
    reviewAt: null,
    pickedWeekStart: null,
    recurrenceRule: null,
    recurrenceTimezone: null,
    recurrenceEndLocalDate: null,
    missPolicy: null,
    habitMode: false,
    minimumAction: null,
    desiredAction: null,
    habitTrigger: null,
    habitOfferSentAt: null,
    seriesRevision: 1,
    version: 1,
    createdAt: new Date("2026-09-01T08:00:00.000Z"),
    updatedAt: new Date("2026-09-01T08:00:00.000Z"),
    ...overrides,
  };
}

function occurrence(overrides) {
  return {
    id: randomUUID(),
    workspaceId: WORKSPACE_ID,
    taskId: ids.taskPoint,
    recurrenceKey: null,
    seriesRevision: 1,
    status: "open",
    timezone: TIMEZONE,
    plannedStartAt: null,
    plannedEndAt: null,
    plannedLocalDate: null,
    dueAt: null,
    dueLocalDate: null,
    expiresAt: null,
    overdue: false,
    elapsedAt: null,
    completedAt: null,
    completedLate: false,
    skipReason: null,
    dstAdjusted: false,
    needsReminderRebuild: false,
    defaultRemindersSuppressed: false,
    version: 3,
    createdAt: new Date("2026-09-01T08:00:00.000Z"),
    updatedAt: new Date("2026-09-01T08:00:00.000Z"),
    ...overrides,
  };
}

function seedStore() {
  const tasks = [
    task({ id: ids.taskPoint, title: "Позвонить маме", importance: "required", plannedStartAt: new Date("2026-09-05T15:00:00.000Z") }),
    task({
      id: ids.taskSeries,
      title: "Зарядка",
      timeMode: "window",
      recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE",
      recurrenceTimezone: TIMEZONE,
      recurrenceEndLocalDate: null,
      missPolicy: "expire",
      plannedStartAt: new Date("2026-09-07T05:00:00.000Z"),
      version: 4,
    }),
    task({ id: ids.taskFuzzy, title: "Разобрать гараж", timeMode: "fuzzy", fuzzyHorizonText: "на этой неделе", reviewAt: new Date("2026-09-06T06:00:00.000Z") }),
    task({
      id: ids.taskPaused,
      title: "Полить цветы",
      status: "paused",
      timeMode: "window",
      recurrenceRule: "FREQ=DAILY;INTERVAL=2",
      recurrenceTimezone: TIMEZONE,
      version: 7,
    }),
    task({ id: ids.foreignTask, workspaceId: OTHER_WORKSPACE_ID, title: "Чужая задача" }),
  ];
  const occurrences = [
    occurrence({ id: ids.occPoint, taskId: ids.taskPoint, plannedStartAt: new Date("2026-09-05T15:00:00.000Z"), version: 3 }),
    occurrence({
      id: ids.occSeriesOne,
      taskId: ids.taskSeries,
      status: "scheduled",
      plannedStartAt: new Date("2026-09-07T05:00:00.000Z"),
      recurrenceKey: "2026-09-07",
      version: 2,
    }),
    occurrence({
      id: ids.occSeriesTwo,
      taskId: ids.taskSeries,
      status: "scheduled",
      plannedStartAt: new Date("2026-09-09T05:00:00.000Z"),
      recurrenceKey: "2026-09-09",
      version: 1,
    }),
    occurrence({ id: ids.foreignOccurrence, workspaceId: OTHER_WORKSPACE_ID, taskId: ids.foreignTask, plannedStartAt: new Date("2026-09-05T15:00:00.000Z") }),
  ];
  const goals = [
    {
      id: ids.goal,
      workspaceId: WORKSPACE_ID,
      createdByUserId: USER_ID,
      sourceActionGroupId: null,
      title: "Форма",
      why: "Дожить до ста",
      status: "active",
      targetLocalDate: "2026-12-31",
      reviewEnabled: true,
      nextReviewAt: null,
      version: 2,
      createdAt: new Date("2026-08-01T08:00:00.000Z"),
      updatedAt: new Date("2026-08-20T08:00:00.000Z"),
    },
    {
      id: ids.foreignGoal,
      workspaceId: OTHER_WORKSPACE_ID,
      createdByUserId: OTHER_USER_ID,
      sourceActionGroupId: null,
      title: "Чужая цель",
      why: null,
      status: "active",
      targetLocalDate: null,
      reviewEnabled: true,
      nextReviewAt: null,
      version: 1,
      createdAt: new Date("2026-08-01T08:00:00.000Z"),
      updatedAt: new Date("2026-08-01T08:00:00.000Z"),
    },
  ];
  const events = [
    {
      id: randomUUID(),
      workspaceId: WORKSPACE_ID,
      taskId: ids.taskPoint,
      occurrenceId: ids.occPoint,
      actorUserId: USER_ID,
      eventType: "occurrence:open",
      details: "жду ответа",
      createdAt: new Date("2026-09-04T10:00:00.000Z"),
    },
    {
      id: randomUUID(),
      workspaceId: WORKSPACE_ID,
      taskId: ids.taskPoint,
      occurrenceId: ids.occPoint,
      actorUserId: OTHER_USER_ID,
      eventType: "occurrence:rescheduled",
      details: "чужая причина",
      createdAt: new Date("2026-09-03T10:00:00.000Z"),
    },
    {
      id: randomUUID(),
      workspaceId: WORKSPACE_ID,
      taskId: ids.taskPoint,
      occurrenceId: ids.occPoint,
      actorUserId: null,
      eventType: "occurrence:overdue",
      details: null,
      createdAt: new Date("2026-09-02T10:00:00.000Z"),
    },
  ];
  return { tasks, occurrences, goals, events, links: [{ workspaceId: WORKSPACE_ID, taskId: ids.taskPoint, goalId: ids.goal }] };
}

/* ------------------------------------------------------------------ initData */

function sign(fields) {
  const dataCheckString = Object.keys(fields)
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  return createHmac("sha256", secret).update(dataCheckString).digest("hex");
}

function initData() {
  const fields = {
    user: JSON.stringify({ id: OWNER_TELEGRAM_ID, first_name: "Owner", language_code: "ru" }),
    chat_type: "sender",
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const all = { ...fields, hash: sign(fields) };
  return Object.entries(all)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

/* ------------------------------------------------------------------ harness */

const CONFIG = {
  nodeEnv: "test",
  appCommit: "abc1234",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused/unused",
  telegramBotToken: BOT_TOKEN,
  botIdentity: "webapp-tasks-test",
  ownerTelegramUserId: OWNER_TELEGRAM_ID,
  webAppEnabled: true,
  webAppUrl: "https://app.example.com/app",
  webAppDistPath: "/nonexistent",
  aiProvider: "openai",
  aiModel: "gpt-test",
  aiTranscriptionModel: "whisper-test",
  aiVoiceMaxDurationSeconds: 120,
  aiVoiceMaxBytes: 1_000_000,
  aiConsentVersion: "2",
  aiPricing: {},
  aiMaxOutputTokens: 1000,
  aiMaxMessagesPerHour: 30,
  aiMaxCallsPerHour: 20,
  openAiApiKey: "sk-openai-key-with-enough-length",
};

const SETTINGS_ROW = {
  userId: USER_ID,
  timezone: TIMEZONE,
  digestTimezone: TIMEZONE,
  quietHoursTimezone: TIMEZONE,
  pinnedLanguage: null,
  telegramLanguage: "ru",
  quietHoursEnabled: false,
  weekdayQuietStart: "22:00",
  weekdayQuietEnd: "08:00",
  weekendQuietStart: "23:00",
  weekendQuietEnd: "09:00",
  notificationsSnoozedUntil: null,
  morningReferenceTime: "09:00",
  eveningReferenceTime: "20:00",
  morningDigestEnabled: true,
  weeklyReviewEnabled: true,
  weeklyReviewWeekday: 7,
  weeklyReviewTime: "20:00",
  onboardingCompletedAt: new Date("2026-01-02T03:04:05.000Z"),
  eventReminderOffsetsMinutes: [-60],
  plannedTaskReminderOffsetMinutes: 0,
  criticalPostDueMinutes: 60,
  seenNormalMinutes: 60,
  seenRequiredMinutes: 30,
  seenCriticalMinutes: 15,
  version: 7,
};

/** A Drizzle-shaped object where every chain is legal and every await yields no rows. */
function inertDb() {
  const chain = () =>
    new Proxy(function () {}, {
      get: (_target, property) => (property === "then" ? (resolve) => resolve([]) : chain()),
      apply: () => chain(),
    });
  return chain();
}

function fakeTasks(store, recorder) {
  const scoped = (workspaceId) => store.tasks.filter((row) => row.workspaceId === workspaceId);
  const occurrencesOf = (workspaceId, taskId) => store.occurrences.filter((row) => row.workspaceId === workspaceId && row.taskId === taskId);
  const live = (row) => ["scheduled", "open", "in_progress"].includes(row.status);
  const screenRows = (workspaceId) => [
    ...store.occurrences
      .filter((row) => row.workspaceId === workspaceId && live(row))
      .flatMap((row) => {
        const owner = scoped(workspaceId).find((candidate) => candidate.id === row.taskId);
        return owner && owner.status === "active" ? [{ task: owner, occurrence: row }] : [];
      }),
    ...scoped(workspaceId)
      .filter((row) => row.status === "active" && row.timeMode === "fuzzy")
      .map((row) => ({ task: row, occurrence: null })),
  ];

  return {
    listScreenRows: async (workspaceId) => screenRows(workspaceId),
    listGrouped: async (workspaceId, input) => ({
      groups: groupTaskRows(filterByScope(screenRows(workspaceId), input.scope, input.localDate), input.localDate),
      counts: scopeCounts(screenRows(workspaceId), input.localDate),
      total: 0,
      pausedCount: scoped(workspaceId).filter((row) => row.status === "paused" && row.recurrenceRule).length,
    }),
    listTodayGrouped: async (workspaceId, localDate) => ({ groups: groupTaskRows(filterByScope(screenRows(workspaceId), "today", localDate), localDate), staleCount: 1 }),
    listCompletedTodayForTelegram: async () => [],
    listPausedSeriesForTelegram: async (workspaceId, input) => {
      const rows = scoped(workspaceId).filter((row) => row.status === "paused" && row.recurrenceRule);
      return { rows: rows.slice(input.offset ?? 0, (input.offset ?? 0) + input.limit), total: rows.length };
    },
    findSeriesPausedAt: async (_workspaceId, taskIds) => new Map(taskIds.map((id) => [id, new Date("2026-09-02T12:00:00.000Z")])),
    getTaskCardExtras: async () => ({ checklist: [], goalTitle: null, recurrenceExcludedLocalDates: ["2026-09-14"] }),
    listRecurrenceExclusions: async () => ["2026-09-14"],
    getTask: async (workspaceId, taskId) => scoped(workspaceId).find((row) => row.id === taskId) ?? null,
    findCurrentOccurrence: async (workspaceId, taskId) => occurrencesOf(workspaceId, taskId).find(live) ?? null,
    findCurrentOccurrences: async (workspaceId, taskIds) => {
      const map = new Map();
      for (const id of taskIds) {
        const found = occurrencesOf(workspaceId, id).find(live);
        if (found) map.set(id, found);
      }
      return map;
    },
    getOccurrenceContext: async (workspaceId, occurrenceId) => {
      const found = store.occurrences.find((row) => row.workspaceId === workspaceId && row.id === occurrenceId);
      if (!found) return null;
      const owner = scoped(workspaceId).find((row) => row.id === found.taskId);
      return owner ? { task: owner, occurrence: found } : null;
    },
    listChecklistsForContext: async (workspaceId, taskIds) =>
      new Map(taskIds.map((id) => [id, [{ id: `${id.slice(0, 8)}-0000-4000-8000-000000000001`, workspaceId, taskId: id, text: "шаг", sortOrder: 0, done: false }]])),
    listOccurrencesForTask: async (workspaceId, taskId) => occurrencesOf(workspaceId, taskId),
    listTaskEvents: async (workspaceId, taskId) => store.events.filter((row) => row.workspaceId === workspaceId && row.taskId === taskId),
    listTaskReminders: async () => [],
    isRescheduleReasonRequired: async (workspaceId, occurrenceId) => {
      const found = store.occurrences.find((row) => row.workspaceId === workspaceId && row.id === occurrenceId);
      if (!found) throw new Error("occurrence not found");
      const owner = store.tasks.find((row) => row.id === found.taskId);
      return owner?.importance !== "normal";
    },
    setOccurrenceStatus: async (input) => {
      recorder.transitions.push(input);
      const found = store.occurrences.find((row) => row.workspaceId === input.workspaceId && row.id === input.occurrenceId);
      found.status = input.nextStatus;
      found.version += 1;
      return found;
    },
    listTasksForActionGroup: async (workspaceId, groupId) => scoped(workspaceId).filter((row) => row.sourceActionGroupId === groupId),
    // Reached only through the reminder loops the module drags in; never by the API.
    reconcileRecurringTask: async () => undefined,
    enqueuePreparedTaskPlans: async () => undefined,
  };
}

function fakeActions(store, recorder) {
  return {
    validateResolved: async (actions) => {
      const issues = [];
      for (const [index, action] of actions.entries()) {
        const stale = (id, version, rows) => {
          const row = rows.find((candidate) => candidate.id === id);
          return !row || row.version !== version;
        };
        if (action.type === "update_task" && stale(action.taskId, action.taskVersion, store.tasks)) {
          issues.push({ index, kind: "reference", code: "stale", message: "target task is missing or stale" });
        }
        if (action.type === "set_task_state" && action.target.kind === "occurrence" && stale(action.target.occurrenceId, action.target.occurrenceVersion, store.occurrences)) {
          issues.push({ index, kind: "reference", code: "stale", message: "target occurrence is missing or stale" });
        }
        // Cancelling a whole repeat addresses the task, so it is the task's version that is stale.
        if (
          action.type === "set_task_state" &&
          (action.target.kind === "series" || action.target.kind === "task") &&
          stale(action.target.taskId, action.target.taskVersion, store.tasks)
        ) {
          issues.push({ index, kind: "reference", code: "stale", message: "target task is missing or stale" });
        }
        if (action.type === "reschedule" && action.reason === null && action.target.kind === "occurrence") {
          const owner = store.tasks.find((row) => row.id === action.target.taskId);
          if (owner && owner.importance !== "normal") issues.push({ index, kind: "domain", code: "reason_required", message: "reschedule reason is required" });
        }
        if (action.type === "goal" && action.op !== "create" && stale(action.goalId, action.goalVersion, store.goals)) {
          issues.push({ index, kind: "reference", code: "stale", message: "target goal is missing or stale" });
        }
      }
      return issues;
    },
    applyResolved: async (actions, scope) => {
      const groupId = randomUUID();
      recorder.applied.push({ groupId, actions: [...actions], scope });
      for (const action of actions) {
        if (action.type === "create_task") store.tasks.push(task({ title: action.body.title, sourceActionGroupId: groupId, timeMode: "window", plannedLocalDate: "2026-09-08" }));
        if (action.type === "goal" && action.op === "create") {
          store.goals.push({
            ...store.goals[0],
            id: randomUUID(),
            title: action.title,
            sourceActionGroupId: groupId,
            version: 1,
            status: "active",
            targetLocalDate: action.targetDate,
          });
        }
      }
      return { groupId, count: actions.length, titles: [], items: [] };
    },
    applySeriesOperation: async (scope, taskId, expectedVersion, operation) => {
      const groupId = randomUUID();
      recorder.series.push({ groupId, taskId, expectedVersion, operation, scope });
      const row = store.tasks.find((candidate) => candidate.id === taskId);
      row.status = operation === "pause" ? "paused" : "active";
      row.version += 1;
      return { applied: { groupId, count: 1, titles: [], items: [] } };
    },
    undo: async (workspaceId, actorUserId, groupId) => {
      recorder.undone.push({ workspaceId, actorUserId, groupId });
    },
    onApplicationBootstrap: async () => undefined,
  };
}

function fakeContext(store) {
  const goalsIn = (workspaceId) => store.goals.filter((row) => row.workspaceId === workspaceId);
  const tasksOfGoal = (workspaceId, goalId) =>
    store.links
      .filter((link) => link.workspaceId === workspaceId && link.goalId === goalId)
      .flatMap((link) => store.tasks.filter((row) => row.id === link.taskId && row.status === "active"));
  return {
    goalsOverview: async (workspaceId, status) => {
      const rows = goalsIn(workspaceId)
        .filter((goal) => ["active", "paused", "completed"].includes(goal.status))
        .map((goal) => ({ goal, tasks: tasksOfGoal(workspaceId, goal.id) }));
      return status ? rows.filter((row) => row.goal.status === status) : rows;
    },
    idleGoals: async (workspaceId) =>
      goalsIn(workspaceId)
        .filter((goal) => goal.status === "active")
        .map((goal) => ({ id: goal.id, title: goal.title, idleDays: 22 })),
    findGoal: async (workspaceId, goalId) => goalsIn(workspaceId).find((row) => row.id === goalId) ?? null,
    findGoalWithTasks: async (workspaceId, goalId) => {
      const goal = goalsIn(workspaceId).find((row) => row.id === goalId);
      return goal ? { goal, tasks: tasksOfGoal(workspaceId, goalId) } : null;
    },
    findGoalForTask: async (workspaceId, taskId) => {
      const link = store.links.find((row) => row.workspaceId === workspaceId && row.taskId === taskId);
      return link ? (goalsIn(workspaceId).find((row) => row.id === link.goalId) ?? null) : null;
    },
    listGoalsForActionGroup: async (workspaceId, groupId) => goalsIn(workspaceId).filter((row) => row.sourceActionGroupId === groupId),
  };
}

async function createApp() {
  const store = seedStore();
  const recorder = { applied: [], series: [], undone: [], transitions: [] };

  const moduleRef = await Test.createTestingModule({
    imports: [WebTasksModule],
    providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(CONFIG)
    .overrideProvider(DatabaseService)
    .useValue({ db: inertDb(), pool: { query: async () => ({ rows: [], rowCount: 0 }), on: () => undefined }, onApplicationShutdown: () => undefined })
    .overrideProvider(TelegramService)
    .useValue({ bot: { api: {} }, sendMessage: async () => 1, onApplicationBootstrap: () => undefined, onApplicationShutdown: () => undefined })
    .overrideProvider(JobQueueService)
    .useValue({
      ensureQueue: async () => undefined,
      send: async () => null,
      work: async () => undefined,
      deadLetterCount: async () => 0,
      onModuleInit: () => undefined,
      onApplicationShutdown: () => undefined,
    })
    .overrideProvider(AccessService)
    .useValue({
      resolveActiveUser: async (telegramUserId) =>
        telegramUserId === OWNER_TELEGRAM_ID ? { user: { id: USER_ID, telegramUserId, status: "active", aiStatus: "enabled" }, workspaceId: WORKSPACE_ID } : null,
      findRestorable: async () => null,
    })
    .overrideProvider(AiService)
    .useValue({
      providerName: "openai",
      consentVersion: "2",
      maxCallsPerHour: 20,
      isConfigured: () => true,
      hasConsent: async () => true,
      hasProviderConsent: async () => true,
      callsLastHour: async () => 0,
      onApplicationBootstrap: () => undefined,
    })
    .overrideProvider(ChatService)
    .useValue({ providerName: "openai", isAiConfigured: () => true, historyMessageCount: async () => 0 })
    .overrideProvider(TasksService)
    .useValue(fakeTasks(store, recorder))
    .overrideProvider(ActionsService)
    .useValue(fakeActions(store, recorder))
    .overrideProvider(ContextService)
    .useValue(fakeContext(store))
    .overrideProvider(ReminderSchedulingService)
    .useValue({
      nextUserReminderAt: async () => new Date("2026-09-05T14:00:00.000Z"),
      nextUserReminderAtMany: async (_workspaceId, occurrenceIds) => new Map(occurrenceIds.map((id) => [id, new Date("2026-09-05T14:00:00.000Z")])),
    })
    .compile();

  const settings = moduleRef.get(SettingsService, { strict: false });
  settings.get = async () => SETTINGS_ROW;

  const app = moduleRef.createNestApplication();
  app.set("trust proxy", 1);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address();
  app.get(ApiIpRateLimiter).reset();
  app.get(ApiUserRateLimiter).reset();

  let address = 0;
  const call = async (method, path, body) => {
    // A fresh client address per call: the IP limiter is the subject of another file, and a test
    // that walks twenty routes must not trip it.
    address += 1;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `tma ${initData()}`,
        "X-Forwarded-For": `198.51.100.${address % 250}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };

  return {
    store,
    recorder,
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body ?? {}),
    patch: (path, body) => call("PATCH", path, body),
    del: (path) => call("DELETE", path),
    close: () => app.close(),
  };
}

const NOT_FOUND = { error: { code: "not_found", message: "Not found" } };

/* -------------------------------------------------------------------- reads */

test("the task list is the bot's own grouping, paged, with the counts every tab would show", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.get("/tasks?scope=all&pageSize=10");
  assert.equal(status, 200);
  const parsed = TaskListResponseSchema.parse(body);

  assert.equal(parsed.scope, "all");
  assert.equal(parsed.timezone, TIMEZONE);
  assert.match(parsed.todayLocalDate, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(parsed.pausedCount, 1, "a paused series lives in no date window and is counted on its own");
  assert.deepEqual(Object.keys(parsed.counts).sort(), ["all", "month", "nodate", "overdue", "today", "week"]);

  const series = parsed.groups.find((group) => group.title === "Зарядка");
  assert.ok(series, "the two dates of one series read as one line");
  assert.equal(series.rows.length, 2);
  assert.ok(series.leadIndex >= 0 && series.leadIndex < series.rows.length);
  assert.equal(series.recurrenceRule, "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE");

  const lead = series.rows[series.leadIndex];
  // The two fields a thin contract would omit and every write would then need a round trip for.
  assert.equal(typeof lead.taskVersion, "number");
  assert.equal(typeof lead.occurrenceVersion, "number");
  assert.equal(typeof lead.overdue, "boolean");
  assert.equal(lead.nextReminderAt, "2026-09-05T14:00:00.000Z");

  const fuzzy = parsed.groups.find((group) => group.title === "Разобрать гараж");
  assert.equal(fuzzy.rows[0].occurrenceId, null, "a fuzzy task has no occurrence");
  assert.equal(fuzzy.rows[0].localDate, null);
  assert.equal(fuzzy.rows[0].fuzzy.horizonText, "на этой неделе");
});

test("today, the paused list and the task screen all answer in the contract's shape", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const today = TodayResponseSchema.parse((await harness.get("/tasks/today")).body);
  assert.equal(today.timezone, TIMEZONE);
  assert.equal(today.staleCount, 1);

  const paused = PausedSeriesResponseSchema.parse((await harness.get("/tasks/paused")).body);
  assert.equal(paused.rows.length, 1);
  assert.equal(paused.rows[0].taskId, ids.taskPaused);
  // `tasks` has no paused_at column; the journal is where «на паузе с …» comes from.
  assert.equal(paused.rows[0].pausedAt, "2026-09-02T12:00:00.000Z");
  assert.equal(paused.rows[0].recurrence.frequency, "daily");
  assert.equal(paused.rows[0].recurrence.interval, 2);

  const detail = TaskDetailSchema.parse((await harness.get(`/tasks/${ids.taskSeries}`)).body);
  assert.equal(detail.id, ids.taskSeries);
  assert.equal(detail.occurrence.id, ids.occSeriesOne);
  assert.deepEqual(
    detail.siblingOccurrences.map((row) => row.id),
    [ids.occSeriesTwo],
    "the other live dates of the same series ride along, so «раскрыть повтор» needs no second call",
  );
  assert.equal(detail.canPauseSeries, true, "an endless repeat is the only series worth pausing");
  assert.deepEqual(detail.recurrence.weekdays, ["MO", "WE"]);
  assert.deepEqual(detail.recurrence.excludedLocalDates, ["2026-09-14"]);
});

test("a deep link names an occurrence and opens the task it belongs to", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  // The launch button on a push carries `#/task/<occurrenceId>`; the list line carries the task.
  const byOccurrence = TaskDetailSchema.parse((await harness.get(`/tasks/${ids.occSeriesTwo}`)).body);
  assert.equal(byOccurrence.id, ids.taskSeries);
  assert.equal(byOccurrence.occurrence.id, ids.occSeriesTwo, "the occurrence the link named, not the current one");
  assert.deepEqual(
    byOccurrence.siblingOccurrences.map((row) => row.id),
    [ids.occSeriesOne],
  );
});

test("the journal is returned, and one member's own words are not handed to another", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const detail = TaskDetailSchema.parse((await harness.get(`/tasks/${ids.taskPoint}`)).body);
  const mine = detail.journal.find((entry) => entry.eventType === "occurrence:open");
  const theirs = detail.journal.find((entry) => entry.eventType === "occurrence:rescheduled");
  const loop = detail.journal.find((entry) => entry.eventType === "occurrence:overdue");

  assert.equal(mine.details, "жду ответа");
  assert.equal(theirs.details, null, "details is the author's own text and travels to nobody else");
  assert.equal(loop.byUser, false, "the expiry loop is not a person");
  assert.equal(mine.byUser, true);
  assert.ok(!JSON.stringify(detail).includes("чужая причина"));

  assert.deepEqual(detail.goal, { id: ids.goal, title: "Форма", version: 2 }, "the goal carries the version an unlink write needs");
});

test("the reschedule sheet is told what it needs before it renders", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const options = RescheduleOptionsSchema.parse((await harness.get(`/tasks/${ids.taskPoint}/reschedule`)).body);
  assert.equal(options.reasonRequired, true, "a required task asks for a reason on the first move");
  assert.equal(options.hasSeries, false);
  assert.equal(options.timezone, TIMEZONE);
  assert.deepEqual(options.presets, ["1h", "evening", "tomorrow"]);
  // Every preset resolves to a real instant, so the button can show the time it will produce.
  for (const preset of options.presets) assert.ok(!Number.isNaN(Date.parse(options.presetTimes[preset])), `${preset} resolves`);
  assert.ok(Date.parse(options.presetTimes["1h"]) > Date.now(), "«+1 ч» is in the future");
});

/* -------------------------------------------------------- workspace isolation */

test("an id from another workspace is the same not-found as an id that never existed", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const version = { expectedVersion: 1 };
  const routes = [
    ["GET", (id) => `/tasks/${id}`, undefined],
    ["GET", (id) => `/tasks/${id}/reschedule`, undefined],
    ["POST", (id) => `/tasks/${id}/state`, { state: "done", expectedVersion: 1 }],
    ["POST", (id) => `/tasks/${id}/reschedule`, { expectedVersion: 1, when: { kind: "preset", preset: "1h" }, reason: null, scope: null, recurrence: null }],
    ["POST", (id) => `/tasks/${id}/checklist`, { expectedVersion: 1, items: [] }],
    ["POST", (id) => `/tasks/${id}/series/pause`, version],
    ["POST", (id) => `/tasks/${id}/series/resume`, version],
    ["PATCH", (id) => `/tasks/${id}`, { expectedVersion: 1, title: "Новое", why: null, nextAction: null, context: null, checklist: null, importance: null, clear: null }],
    ["GET", (id) => `/goals/${id}`, undefined],
    ["PATCH", (id) => `/goals/${id}`, { expectedVersion: 1, title: "Новое", why: null, targetLocalDate: null, status: null, reviewEnabled: null, clear: null }],
    ["POST", (id) => `/goals/${id}/tasks`, { taskId: ids.taskPoint, expectedGoalVersion: 1, expectedTaskVersion: 1 }],
    ["DELETE", (id) => `/goals/${id}/tasks/${ids.taskPoint}`, undefined],
  ];

  for (const [method, path, body] of routes) {
    const foreign = path("").startsWith("/goals") ? ids.foreignGoal : ids.foreignTask;
    const send = (id) =>
      method === "GET" ? harness.get(path(id)) : method === "DELETE" ? harness.del(path(id)) : method === "PATCH" ? harness.patch(path(id), body) : harness.post(path(id), body);

    const other = await send(foreign);
    const missing = await send(ids.unknown);
    assert.equal(other.status, 404, `${method} ${path("<foreign>")}`);
    assert.deepEqual(other.body, NOT_FOUND, `${method} ${path("<foreign>")} must not say more than «not found»`);
    assert.deepEqual(missing.body, other.body, `${method} ${path("<unknown>")} answers identically`);
  }

  // And the foreign occurrence, which is the id a shared deep link would carry.
  const byOccurrence = await harness.get(`/tasks/${ids.foreignOccurrence}`);
  assert.equal(byOccurrence.status, 404);
  assert.deepEqual(byOccurrence.body, NOT_FOUND);

  // `POST /goals/:id/tasks` is the one route with a *second* id, and it arrives in the body. The
  // loop above only ever varied the goal. Both ids are scoped, and both answer the same way.
  for (const taskId of [ids.foreignTask, ids.unknown]) {
    const linked = await harness.post(`/goals/${ids.goal}/tasks`, { taskId, expectedGoalVersion: 2, expectedTaskVersion: 1 });
    assert.equal(linked.status, 404, `link to ${taskId === ids.unknown ? "an unknown" : "a foreign"} task`);
    assert.deepEqual(linked.body, NOT_FOUND, "a task outside the workspace is a not-found, never a conflict the client retries");
  }

  assert.deepEqual(harness.recorder.applied, [], "not one of those refusals reached the write path");
  assert.deepEqual(harness.recorder.series, []);
});

test("the goals list shows only this workspace's goals", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const parsed = GoalsResponseSchema.parse((await harness.get("/goals")).body);
  assert.deepEqual(
    parsed.goals.map((goal) => goal.id),
    [ids.goal],
  );
  assert.ok(!JSON.stringify(parsed).includes("Чужая цель"));
  assert.deepEqual(parsed.counts, { active: 1, paused: 0, completed: 0 });
  assert.equal(parsed.goals[0].taskCount, 1, "the list line says only how much of the goal is planned");
  assert.equal(parsed.goals[0].idleDays, 22, "the same goal the weekly card would raise, marked here too");

  const detail = GoalDetailSchema.parse((await harness.get(`/goals/${ids.goal}`)).body);
  assert.deepEqual(
    detail.tasks.map((row) => row.taskId),
    [ids.taskPoint],
  );
  assert.equal(detail.tasks[0].occurrenceId, ids.occPoint);
});

/* ------------------------------------------------------------------- writes */

test("a state change goes through the action journal with the versions the client read", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.post(`/tasks/${ids.occPoint}/state`, { state: "done", expectedVersion: 3 });
  assert.equal(status, 201);
  const parsed = TaskMutationResponseSchema.parse(body);

  assert.equal(harness.recorder.applied.length, 1, "the write is one action group, exactly like the same tap in chat");
  const [applied] = harness.recorder.applied;
  const [action] = applied.actions;
  assert.equal(action.type, "set_task_state");
  assert.equal(action.intent, "explicit");
  assert.equal(action.state, "done");
  assert.deepEqual(action.target, {
    kind: "occurrence",
    taskId: ids.taskPoint,
    taskVersion: 1,
    occurrenceId: ids.occPoint,
    occurrenceVersion: 3,
    timezone: TIMEZONE,
  });
  assert.equal(applied.scope.actorUserId, USER_ID);
  assert.equal(applied.scope.workspaceId, WORKSPACE_ID);

  // Undo is offered because the group can truthfully roll the change back.
  assert.equal(parsed.undoGroupId, applied.groupId);

  const undone = await harness.post("/undo", { groupId: applied.groupId });
  assert.equal(undone.status, 201);
  assert.deepEqual(undone.body, { undone: true });
  assert.deepEqual(harness.recorder.undone, [{ workspaceId: WORKSPACE_ID, actorUserId: USER_ID, groupId: applied.groupId }]);
});

test("cancelling a repeat can mean this date or the whole rule, and the version follows the target", async (t) => {
  // `set_task_state` has always had both answers; only one was reachable over HTTP, so cancelling a
  // repeating task closed one date and the rule produced the next one anyway.
  const harness = await createApp();
  t.after(() => harness.close());

  const one = await harness.post(`/tasks/${ids.occSeriesOne}/state`, { state: "cancelled", expectedVersion: 2, scope: "occurrence" });
  assert.equal(one.status, 201);
  assert.equal(harness.recorder.applied[0].actions[0].target.kind, "occurrence");
  assert.equal(harness.recorder.applied[0].actions[0].target.occurrenceVersion, 2, "an occurrence cancel carries the occurrence version");

  // The whole repeat addresses the task, so the *task* version is what travels — the table in the
  // contract, not a guess from the id in the path.
  const whole = await harness.post(`/tasks/${ids.occSeriesOne}/state`, { state: "cancelled", expectedVersion: 4, scope: "series" });
  assert.equal(whole.status, 201);
  assert.deepEqual(harness.recorder.applied[1].actions[0].target, { kind: "series", taskId: ids.taskSeries, taskVersion: 4 });

  // And a stale task version is the conflict for the task, not for the occurrence under it.
  const stale = await harness.post(`/tasks/${ids.occSeriesOne}/state`, { state: "cancelled", expectedVersion: 1, scope: "series" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.currentVersion, 4);

  // A one-off has no series to cancel, and says so by name rather than closing something else.
  const notRecurring = await harness.post(`/tasks/${ids.occPoint}/state`, { state: "cancelled", expectedVersion: 1, scope: "series" });
  assert.equal(notRecurring.status, 422);
  assert.equal(notRecurring.body.error.details.rule, "not_recurring");
});

test("«seen» records what is blocking it in the journal and promises no Undo", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.post(`/tasks/${ids.occPoint}/state`, { state: "seen", expectedVersion: 3, note: "жду ответа от банка" });
  assert.equal(status, 201);
  const parsed = TaskMutationResponseSchema.parse(body);

  assert.deepEqual(harness.recorder.applied, [], "there is no set_task_state for «seen»; inventing a group would invent an Undo");
  assert.equal(harness.recorder.transitions.length, 1);
  const [transition] = harness.recorder.transitions;
  assert.equal(transition.nextStatus, "open");
  assert.equal(transition.expectedVersion, 3);
  assert.equal(transition.actorUserId, USER_ID);
  assert.equal(transition.note, "жду ответа от банка", "the note is journalled as the event's details — the only truthful place for it");
  assert.equal(parsed.undoGroupId, null);

  const started = await harness.post(`/tasks/${ids.occPoint}/state`, { state: "started", expectedVersion: 4 });
  assert.equal(started.status, 201);
  assert.equal(harness.recorder.transitions[1].nextStatus, "in_progress");
});

test("a stale version is a typed conflict carrying the row's own number, not a 500", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const patch = await harness.patch(`/tasks/${ids.taskSeries}`, {
    expectedVersion: 1,
    title: "Зарядка утром",
    why: null,
    nextAction: null,
    context: null,
    checklist: null,
    importance: null,
    clear: null,
  });
  assert.equal(patch.status, 409);
  assert.deepEqual(patch.body, { error: { code: "conflict", message: "The object changed since it was read", details: { kind: "conflict", currentVersion: 4 } } });
  assert.deepEqual(harness.recorder.applied, [], "a refused write never reaches the journal");

  const state = await harness.post(`/tasks/${ids.occPoint}/state`, { state: "done", expectedVersion: 1 });
  assert.equal(state.status, 409);
  assert.equal(state.body.error.details.currentVersion, 3);

  // «seen» takes the same answer, decided before the transaction rather than inside it.
  const seen = await harness.post(`/tasks/${ids.occPoint}/state`, { state: "seen", expectedVersion: 1, note: null });
  assert.equal(seen.status, 409);
  assert.deepEqual(harness.recorder.transitions, []);

  const series = await harness.post(`/tasks/${ids.taskSeries}/series/pause`, { expectedVersion: 1 });
  assert.equal(series.status, 409);
  assert.deepEqual(harness.recorder.series, []);
});

test("a domain rule the request breaks is named by its code, never by its message", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const moved = await harness.post(`/tasks/${ids.occPoint}/reschedule`, {
    expectedVersion: 3,
    when: { kind: "preset", preset: "tomorrow" },
    reason: null,
    scope: null,
    recurrence: null,
  });
  assert.equal(moved.status, 422);
  assert.deepEqual(moved.body, { error: { code: "domain_rule", message: "The change is not allowed by a domain rule", details: { kind: "rule", rule: "reason_required" } } });
  assert.deepEqual(harness.recorder.applied, []);

  // With the reason the same request is applied, and the preset became a concrete `when`.
  const withReason = await harness.post(`/tasks/${ids.occPoint}/reschedule`, {
    expectedVersion: 3,
    when: { kind: "preset", preset: "tomorrow" },
    reason: { code: "time", text: null },
    scope: null,
    recurrence: null,
  });
  assert.equal(withReason.status, 201);
  const [applied] = harness.recorder.applied;
  assert.equal(applied.actions[0].type, "reschedule");
  assert.equal(applied.actions[0].reason, "time");
  assert.ok(["exact", "date", "deadline", "fuzzy"].includes(applied.actions[0].when.mode), "the preset is resolved on the server, not sent as a word");
});

test("resume offers no Undo, because undoing it would leave the dates it materialized live", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const paused = TaskMutationResponseSchema.parse((await harness.post(`/tasks/${ids.taskPaused}/series/pause`, { expectedVersion: 7 })).body);
  assert.equal(harness.recorder.series[0].operation, "pause");
  assert.equal(paused.undoGroupId, harness.recorder.series[0].groupId);

  const resumed = TaskMutationResponseSchema.parse((await harness.post(`/tasks/${ids.taskPaused}/series/resume`, { expectedVersion: 8 })).body);
  assert.equal(harness.recorder.series[1].operation, "resume");
  assert.equal(resumed.undoGroupId, null, "pausing again is the honest way back, not an Undo that lies");
});

test("a checklist tick is a whole-list write through the journal, because the domain has no other", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status } = await harness.post(`/tasks/${ids.taskPoint}/checklist`, { expectedVersion: 1, items: [{ text: "шаг", done: true }] });
  assert.equal(status, 201);
  const [applied] = harness.recorder.applied;
  assert.equal(applied.actions[0].type, "update_task");
  assert.deepEqual(applied.actions[0].patch.checklist, [{ text: "шаг", done: true }]);
  assert.equal(applied.actions[0].taskVersion, 1);
});

test("a create is journalled and answers with the row it actually wrote", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.post("/tasks", {
    title: "Сдать отчёт",
    why: null,
    nextAction: null,
    context: null,
    checklist: null,
    importance: "normal",
    kind: "task",
    when: { mode: "date", date: "2026-09-08" },
    recurrence: null,
    reminder: null,
    timezone: null,
    goalId: ids.goal,
  });
  assert.equal(status, 201);
  const parsed = TaskMutationResponseSchema.parse(body);
  assert.equal(parsed.task.title, "Сдать отчёт");

  const [applied] = harness.recorder.applied;
  assert.equal(applied.actions[0].type, "create_task");
  assert.equal(applied.actions[0].timezone, TIMEZONE, "the profile timezone, since the request named none");
  assert.deepEqual(applied.actions[0].goal, { goalId: ids.goal, goalVersion: 2 });
  assert.equal(parsed.undoGroupId, applied.groupId);

  // A goal that is not in this workspace cannot be attached, and says only «not found».
  const foreign = await harness.post("/tasks", {
    title: "Ещё одна",
    why: null,
    nextAction: null,
    context: null,
    checklist: null,
    importance: "normal",
    kind: "task",
    when: { mode: "date", date: "2026-09-08" },
    recurrence: null,
    reminder: null,
    timezone: null,
    goalId: ids.foreignGoal,
  });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, NOT_FOUND);
});

test("goals are created, linked and unlinked through the same journal", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const created = GoalMutationResponseSchema.parse((await harness.post("/goals", { title: "Отпуск", why: null, targetLocalDate: null })).body);
  assert.equal(created.goal.goal.title, "Отпуск");
  assert.equal(harness.recorder.applied[0].actions[0].op, "create");
  assert.equal(created.undoGroupId, harness.recorder.applied[0].groupId);

  const linked = await harness.post(`/goals/${ids.goal}/tasks`, { taskId: ids.taskSeries, expectedGoalVersion: 2, expectedTaskVersion: 4 });
  assert.equal(linked.status, 201);
  assert.equal(harness.recorder.applied[1].actions[0].op, "link");
  assert.equal(harness.recorder.applied[1].actions[0].taskVersion, 4);

  const unlinked = await harness.del(`/goals/${ids.goal}/tasks/${ids.taskPoint}`);
  assert.equal(unlinked.status, 200);
  assert.equal(harness.recorder.applied[2].actions[0].op, "unlink");

  // A stale goal version is the same typed conflict every other write returns.
  const stale = await harness.post(`/goals/${ids.goal}/tasks`, { taskId: ids.taskSeries, expectedGoalVersion: 1, expectedTaskVersion: 4 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.currentVersion, 2);
});

test("a goal field the action cannot carry is refused by name, never accepted and dropped", async (t) => {
  // `update_goal`'s patch is title, why, target date and status. `clear` and `reviewEnabled` have
  // no slot in it, and answering 200 to either would be a write that reports «сохранено» and moves
  // nothing — which is the one thing the journal exists to make impossible.
  const harness = await createApp();
  t.after(() => harness.close());

  const patch = { expectedVersion: 2, title: null, why: null, targetLocalDate: null, status: null, reviewEnabled: null, clear: null };

  const cleared = await harness.patch(`/goals/${ids.goal}`, { ...patch, clear: ["why"] });
  assert.equal(cleared.status, 422);
  assert.equal(cleared.body.error.details.rule, "goal_clear_unsupported");

  const review = await harness.patch(`/goals/${ids.goal}`, { ...patch, reviewEnabled: false });
  assert.equal(review.status, 422);
  assert.equal(review.body.error.details.rule, "goal_review_unsupported");

  assert.deepEqual(harness.recorder.applied, [], "neither reached the journal");

  // What the action does carry still goes through it.
  const status = await harness.patch(`/goals/${ids.goal}`, { ...patch, status: "paused" });
  assert.equal(status.status, 200);
  assert.equal(harness.recorder.applied[0].actions[0].status, "paused");
});

test("a request the contract refuses names the fields and never their values", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const bad = await harness.post(`/tasks/${ids.occPoint}/state`, { state: "elapsed", expectedVersion: 3, secret: "sk-canary-value" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "validation_failed");
  assert.ok(!JSON.stringify(bad.body).includes("sk-canary-value"), "a validation error must not reflect the request back");

  const badId = await harness.get("/tasks/not-a-uuid");
  assert.equal(badId.status, 400);
  assert.equal(badId.body.error.code, "validation_failed");
});
