import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { AccessService } from "../../dist/access/access.service.js";
import { ActionsService } from "../../dist/actions/actions.service.js";
import { AiService } from "../../dist/ai/ai.service.js";
import { ApiIpRateLimiter, ApiUserRateLimiter } from "../../dist/api/auth/rate-limiter.js";
import { WebSettingsModule } from "../../dist/api/settings/web-settings.module.js";
import {
  API_PREFIX,
  ENDPOINTS,
  ConsentResponseSchema,
  MemoryResponseSchema,
  ProfileResponseSchema,
  RemindersResponseSchema,
  SettingsMutationResponseSchema,
  SettingsResponseSchema,
  TimezoneSearchResponseSchema,
} from "../../dist/api/contracts/index.js";
import { ApiExceptionFilter } from "../../dist/api/http/api-exception.filter.js";
import { ChatService } from "../../dist/chat/chat.service.js";
import { APP_CONFIG } from "../../dist/config.js";
import { ContextService } from "../../dist/context/context.service.js";
import { DatabaseService } from "../../dist/database/database.service.js";
import { JobQueueService } from "../../dist/queue/job-queue.service.js";
import { ReminderSchedulingService } from "../../dist/reminders/reminder-scheduling.service.js";
import { SettingsService } from "../../dist/settings/settings.service.js";
import { TasksService } from "../../dist/tasks/tasks.service.js";
import { TelegramService } from "../../dist/telegram/telegram.service.js";

/**
 * Group 3's endpoints over a real socket: reminders, settings, memory, consent and deletion.
 *
 * Everything below the controllers is a fake, because the subject is what the API does with the
 * domain, not what the domain does. Four properties are what these tests exist for:
 *
 * - a settings change is the same journaled action the bot's settings commands build, and the
 *   timezone question reaches the domain as an answer rather than as a silent default;
 * - quiet hours, whose weekend window may be absent and whose window may cross midnight, are passed
 *   through to `buildSettingsPatch` untouched instead of re-derived here;
 * - an id from another workspace is a `not_found`, the same envelope as an id that never existed;
 * - a sensitive memory cannot be written or deleted without an explicit confirmation, and a
 *   `DELETE` whose body a proxy stripped fails loudly rather than quietly.
 */

const BOT_TOKEN = "123456:AA-test-bot-token-not-a-real-one";
const OWNER_TELEGRAM_ID = 4242;
const USER_ID = "1f2e3d4c-5b6a-4798-8899-aabbccddeeff";
const WORKSPACE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const GROUP_ID = "8c8d3ba4-1f0b-4d1e-9b2a-1c0d2e3f4a5b";

const CONFIG = {
  nodeEnv: "test",
  appCommit: "abc1234",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused/unused",
  telegramBotToken: BOT_TOKEN,
  botIdentity: "webapp-settings-test",
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

const ACTIVE_ACCESS = {
  user: { id: USER_ID, telegramUserId: OWNER_TELEGRAM_ID, status: "active", aiStatus: "enabled" },
  workspaceId: WORKSPACE_ID,
};

function settingsRow(overrides = {}) {
  return {
    userId: USER_ID,
    timezone: "Europe/Kyiv",
    digestTimezone: "Europe/Kyiv",
    quietHoursTimezone: "Europe/Kyiv",
    pinnedLanguage: null,
    telegramLanguage: "ru",
    quietHoursEnabled: true,
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
    profileInvitedAt: null,
    eventReminderOffsetsMinutes: [-60, -15],
    plannedTaskReminderOffsetMinutes: 0,
    criticalPostDueMinutes: 60,
    seenNormalMinutes: 60,
    seenRequiredMinutes: 30,
    seenCriticalMinutes: 15,
    version: 7,
    ...overrides,
  };
}

const MEMORY_ID = "5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const SENSITIVE_ID = "6e7f8091-2b3c-4d5e-9f0a-1b2c3d4e5f60";
const CONTEXT_ID = "7f809102-3c4d-4e5f-8a0b-2c3d4e5f6071";

function memoryRows() {
  return [
    {
      id: MEMORY_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      type: "preference",
      content: "Пьёт кофе только до полудня",
      sensitive: false,
      source: "ai",
      sourceMessageId: null,
      version: 3,
      createdAt: new Date("2026-02-01T08:00:00.000Z"),
      updatedAt: new Date("2026-03-01T08:00:00.000Z"),
    },
    {
      id: SENSITIVE_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      type: "note",
      content: "Диагноз, о котором просил не напоминать",
      sensitive: true,
      source: "user_explicit",
      sourceMessageId: null,
      version: 1,
      createdAt: new Date("2026-02-02T08:00:00.000Z"),
      updatedAt: new Date("2026-02-02T08:00:00.000Z"),
    },
    {
      id: CONTEXT_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      type: "context",
      content: "Работает по берлинскому времени",
      sensitive: false,
      source: "onboarding",
      sourceMessageId: null,
      version: 2,
      createdAt: new Date("2026-01-10T08:00:00.000Z"),
      updatedAt: new Date("2026-01-11T08:00:00.000Z"),
    },
  ];
}

const DELIVERY_ID = "9a0b1c2d-3e4f-4051-8263-748596a7b8c9";
const TASK_ID = "aabbccdd-1122-4334-8556-778899aabbcc";
const OCCURRENCE_ID = "bbccddee-2233-4445-9667-8899aabbccdd";

function deliveryRow() {
  return {
    delivery: {
      id: DELIVERY_ID,
      workspaceId: WORKSPACE_ID,
      recipientUserId: USER_ID,
      reminderRuleId: "ccddeeff-3344-4556-8778-99aabbccddee",
      taskId: TASK_ID,
      occurrenceId: OCCURRENCE_ID,
      intendedFor: new Date("2026-09-10T06:00:00.000Z"),
      scheduledFor: new Date("2026-09-10T06:00:00.000Z"),
      status: "pending",
    },
    task: { id: TASK_ID, title: "Позвонить в банк", timezone: "Europe/Kyiv", version: 4 },
    occurrence: { id: OCCURRENCE_ID, timezone: "Europe/Kyiv", version: 2, status: "open" },
    rule: { purpose: "user_reminder", origin: "explicit" },
  };
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
    user: JSON.stringify({ id: OWNER_TELEGRAM_ID, first_name: "Canary", language_code: "ru" }),
    chat_type: "sender",
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  return Object.entries({ ...fields, hash: sign(fields) })
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

/* ------------------------------------------------------------------ harness */

async function createApp(options = {}) {
  const state = {
    settings: settingsRow(options.settings ?? {}),
    memory: options.memory ?? memoryRows(),
    deliveries: options.deliveries ?? [deliveryRow()],
    issues: [],
    applyThrows: null,
    followUpResult: "dddd0011-4455-4667-8889-99aabbccddee",
    cancelResult: true,
    deleteAfter: new Date("2026-09-19T06:00:00.000Z"),
  };
  const calls = { validate: [], apply: [], applyProfileTimezone: [], snoozeUntilMorning: 0, consent: [], cleared: 0, requestDeletion: [], followUp: [], cancelUpcoming: [] };

  const moduleRef = await Test.createTestingModule({
    imports: [WebSettingsModule],
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
      resolveActiveUser: async (telegramUserId) => (telegramUserId === OWNER_TELEGRAM_ID ? ACTIVE_ACCESS : null),
      findRestorable: async () => null,
      requestDeletion: async (telegramUserId) => {
        calls.requestDeletion.push(telegramUserId);
        return state.deleteAfter;
      },
    })
    .overrideProvider(SettingsService)
    .useValue({
      get: async () => state.settings,
      applyProfileTimezone: async (userId, target) => {
        calls.applyProfileTimezone.push({ userId, target });
      },
      snoozeUntilMorning: async () => {
        calls.snoozeUntilMorning += 1;
        state.settings = { ...state.settings, notificationsSnoozedUntil: new Date("2026-09-06T06:00:00.000Z"), version: state.settings.version + 1 };
        return state.settings.notificationsSnoozedUntil;
      },
    })
    .overrideProvider(ActionsService)
    .useValue({
      validateResolved: async (actions, scope) => {
        calls.validate.push({ actions, scope });
        return state.issues;
      },
      applyResolved: async (actions, scope) => {
        calls.apply.push({ actions, scope });
        if (state.applyThrows) throw state.applyThrows;
        state.settings = { ...state.settings, version: state.settings.version + 1 };
        return { groupId: GROUP_ID, count: actions.length, titles: [], items: [] };
      },
      onApplicationBootstrap: () => undefined,
    })
    .overrideProvider(ContextService)
    .useValue({
      /**
       * The paged read the memory screen makes: whole rows (the version every write is checked
       * against travels with them), an offset rather than a cap, and counts taken over the filter
       * rather than over the page — which is what makes `sensitiveCount` mean anything.
       */
      memoryPage: async (workspaceId, userId, { page, pageSize, type }) => {
        // Scoped on the row, the way the SQL is: `workspace_id` *and* `user_id` are in the WHERE.
        const all = state.memory.filter((row) => row.workspaceId === workspaceId && row.userId === userId && (!type || row.type === type));
        const pages = Math.max(1, Math.ceil(all.length / pageSize));
        const clamped = Math.min(Math.max(page, 0), pages - 1);
        return {
          rows: all.slice(clamped * pageSize, clamped * pageSize + pageSize),
          page: clamped,
          pages,
          total: all.length,
          sensitive: all.filter((row) => row.sensitive).length,
        };
      },
      findMemory: async (workspaceId, userId, memoryId) => state.memory.find((row) => row.id === memoryId && row.workspaceId === workspaceId && row.userId === userId) ?? null,
      profileOverview: async (workspaceId, userId) => state.memory.filter((row) => row.type === "context" && row.workspaceId === workspaceId && row.userId === userId),
    })
    .overrideProvider(ReminderSchedulingService)
    .useValue({
      // The window is real: the query is `order by scheduled_for limit N`, and the controller's own
      // `WINDOW` is what decides how far the *list* reaches.
      listUpcoming: async ({ workspaceId, userId, limit }) => (workspaceId === WORKSPACE_ID && userId === USER_ID ? state.deliveries.slice(0, limit ?? 12) : []),
      /**
       * Addressed by id, and scoped by the same pair. It is deliberately *not* «find it in the
       * list»: the list is a window, and a delivery past it must still be snoozable and
       * cancellable — which is the bug this method exists to close.
       */
      findUpcoming: async ({ workspaceId, userId, deliveryId }) =>
        (workspaceId === WORKSPACE_ID && userId === USER_ID ? state.deliveries.find((row) => row.delivery.id === deliveryId) : undefined) ?? null,
      cancelUpcoming: async (input) => {
        calls.cancelUpcoming.push(input);
        return state.cancelResult;
      },
      scheduleFollowUpChoice: async (input) => {
        calls.followUp.push(input);
        return state.followUpResult;
      },
      validateExplicitReminderChange: async () => undefined,
      nextUserReminderAt: async () => null,
      nextUserReminderAtMany: async () => new Map(),
      rebuildOccurrence: async () => 0,
      rebuildFuzzyTask: async () => 0,
      reconcileFuzzyReviews: async () => 0,
    })
    .overrideProvider(TasksService)
    .useValue({
      getOccurrenceContext: async (workspaceId, occurrenceId) => {
        const row = state.deliveries.find((entry) => entry.occurrence?.id === occurrenceId);
        return row && workspaceId === WORKSPACE_ID ? { task: row.task, occurrence: row.occurrence } : null;
      },
    })
    .overrideProvider(ChatService)
    .useValue({
      providerName: "openai",
      isAiConfigured: () => true,
      historyMessageCount: async () => 12,
      clearConversation: async () => {
        calls.cleared += 1;
        return 9;
      },
      grantConsent: async () => calls.consent.push("grant:text"),
      grantVoiceConsent: async () => calls.consent.push("grant:voice"),
      revokeConsent: async () => calls.consent.push("revoke:text"),
    })
    .overrideProvider(AiService)
    .useValue({
      providerName: "openai",
      consentVersion: CONFIG.aiConsentVersion,
      maxCallsPerHour: CONFIG.aiMaxCallsPerHour,
      isConfigured: () => true,
      hasConsent: async () => calls.consent.includes("grant:text") || calls.consent.includes("grant:voice"),
      hasProviderConsent: async () => calls.consent.includes("grant:voice"),
      revokeProviderConsent: async (_userId, provider) => calls.consent.push(`revoke:${provider}`),
      callsLastHour: async () => 0,
      onApplicationBootstrap: () => undefined,
    })
    .compile();

  const app = moduleRef.createNestApplication();
  app.set("trust proxy", 1);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address();
  app.get(ApiIpRateLimiter).reset();
  app.get(ApiUserRateLimiter).reset();

  let address = 0;
  const request = async (method, path, body) => {
    // Every call gets its own client address: the IP limiter is a real singleton in this graph and
    // a file with thirty requests in it would otherwise start failing on the limit, not the subject.
    address += 1;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `tma ${initData()}`,
        "X-Forwarded-For": `203.0.113.${address % 250}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  return {
    app,
    state,
    calls,
    request,
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    del: (path, body) => request("DELETE", path, body),
    close: () => app.close(),
  };
}

/* ------------------------------------------------------------------ the route table */

test("every endpoint the contract reserves for group 3 is routed, and nothing else is", () => {
  // Read off the decorators rather than probed over HTTP: an unrouted path answers `not_found`
  // through the same filter as a foreign id, so a missing endpoint would look like a working one.
  const routed = new Set();
  for (const controller of Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, WebSettingsModule) ?? []) {
    const base = Reflect.getMetadata(PATH_METADATA, controller) ?? "";
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name];
      if (name === "constructor" || typeof handler !== "function") continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler);
      if (path === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)];
      routed.add(`${method} ${`${base}/${path}`.replace(/\/+/gu, "/").replace(/\/$/u, "")}`);
    }
  }

  const reserved = new Set(
    Object.values(ENDPOINTS)
      .filter((endpoint) => endpoint.group === 3)
      .map((endpoint) => `${endpoint.method} ${API_PREFIX}${endpoint.path}`),
  );
  assert.deepEqual([...reserved].filter((route) => !routed.has(route)).sort(), [], "an endpoint the client already calls has no controller");
  assert.deepEqual([...routed].filter((route) => !reserved.has(route)).sort(), [], "a route nobody declared is a second contract");
});

/* ------------------------------------------------------------------ settings */

test("GET /settings is the same mapping /me embeds", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.get("/settings");
  assert.equal(status, 200);
  const parsed = SettingsResponseSchema.parse(body);
  assert.equal(parsed.version, 7);
  assert.equal(parsed.timezone, "Europe/Kyiv");
  assert.equal(parsed.resolvedLocale, "ru");
  assert.deepEqual(parsed.quietHours, { enabled: true, weekdayStart: "22:00", weekdayEnd: "08:00", weekendStart: "23:00", weekendEnd: "09:00", timezone: "Europe/Kyiv" });
  assert.equal(parsed.historyMessageCount, 12);
});

test("a timezone change carries the answer to the question the bot asks with tzapply:", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  // «Обе» is one journaled step: the patch builder moves all three columns, so Undo restores all
  // three. The bot reaches the same state in two writes because the button arrives after the fact.
  const both = await harness.patch("/settings", { expectedVersion: 7, change: { operation: "timezone", timezone: "киев", applyTo: "both" } });
  assert.equal(both.status, 200);
  const [applied] = harness.calls.apply.at(-1).actions;
  assert.equal(applied.operation, "timezone");
  assert.equal(applied.timezone, "Europe/Kyiv", "a city name is resolved by the same lookup /timezone uses");
  assert.equal(applied.applyTimezoneTo, "all");
  assert.equal(applied.expectedVersion, 7);
  assert.deepEqual(harness.calls.applyProfileTimezone, [], "«both» needs no second, unjournaled copy");

  // A single target is the copy `tzapply:digests` performs, on top of the journaled profile change.
  harness.state.settings = settingsRow({ version: 9 });
  const digests = await harness.patch("/settings", { expectedVersion: 9, change: { operation: "timezone", timezone: "Europe/Berlin", applyTo: "digests" } });
  assert.equal(digests.status, 200);
  assert.equal(harness.calls.apply.at(-1).actions[0].applyTimezoneTo, "profile_only");
  assert.deepEqual(harness.calls.applyProfileTimezone, [{ userId: USER_ID, target: "digests" }]);

  // And «оставить как есть» touches nothing but the profile.
  harness.state.settings = settingsRow({ version: 11 });
  await harness.patch("/settings", { expectedVersion: 11, change: { operation: "timezone", timezone: "Europe/Berlin", applyTo: "keep" } });
  assert.equal(harness.calls.apply.at(-1).actions[0].applyTimezoneTo, "profile_only");
  assert.equal(harness.calls.applyProfileTimezone.length, 1, "keep adds no copy");
});

test("an unresolvable timezone is refused before anything is written", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.patch("/settings", { expectedVersion: 7, change: { operation: "timezone", timezone: "Nowhere/Nothing", applyTo: "keep" } });
  assert.equal(status, 422);
  assert.deepEqual(body.error.details, { kind: "rule", rule: "timezone" });
  assert.equal(harness.calls.apply.length, 0);
  // The refusal names a rule token, never the value the request sent.
  assert.ok(!JSON.stringify(body).includes("Nowhere"));
});

test("a stale version is a conflict carrying the row's own number, not the request's", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.patch("/settings", { expectedVersion: 3, change: { operation: "language", language: "uk" } });
  assert.equal(status, 409);
  assert.equal(body.error.code, "conflict");
  assert.deepEqual(body.error.details, { kind: "conflict", currentVersion: 7 });
  assert.equal(harness.calls.apply.length, 0);
});

test("quiet hours keep their two windows, an absent weekend range and a window that crosses midnight", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  // One range is enough: `buildSettingsPatch` lets the weekend follow the weekday range. The API
  // must pass the nulls through rather than filling them in with a second opinion.
  const one = await harness.patch("/settings", {
    expectedVersion: 7,
    change: { operation: "quiet_hours", enabled: true, weekdayStart: "23:00", weekdayEnd: "07:30", weekendStart: null, weekendEnd: null },
  });
  assert.equal(one.status, 200);
  const action = harness.calls.apply.at(-1).actions[0];
  assert.equal(action.operation, "quiet_hours");
  assert.equal(action.weekdayStart, "23:00");
  assert.equal(action.weekdayEnd, "07:30", "a window crossing midnight is a window, not an error");
  assert.equal(action.weekendStart, null);
  assert.equal(action.weekendEnd, null);

  // Turning them off carries no window at all, exactly as `/quiet off` does.
  harness.state.settings = settingsRow({ version: 9 });
  await harness.patch("/settings", {
    expectedVersion: 9,
    change: { operation: "quiet_hours", enabled: false, weekdayStart: null, weekdayEnd: null, weekendStart: null, weekendEnd: null },
  });
  assert.equal(harness.calls.apply.at(-1).actions[0].enabled, false);
});

test("a domain refusal from validation keeps its code and writes nothing", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  harness.state.issues = [{ kind: "domain", index: 0, code: "settings_shape", message: "weekly review requires weekday and time" }];
  const { status, body } = await harness.patch("/settings", { expectedVersion: 7, change: { operation: "weekly_review", enabled: true, weekday: null, time: null } });
  assert.equal(status, 422);
  assert.deepEqual(body.error.details, { kind: "rule", rule: "settings_shape" });
  assert.equal(harness.calls.apply.length, 0);
  assert.ok(!JSON.stringify(body).includes("weekday and time"), "the domain's sentence is logged, never returned");
});

test("the presets are journaled, and «отложить до утра» takes the road /snooze morning takes", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  // `digest_preset` has no counterpart in `SettingsActionSchema`; it is the same patch as `digest`
  // at the preset time, so it is journaled rather than written past the action journal.
  await harness.patch("/settings", { expectedVersion: 7, change: { operation: "digest_preset", enabled: true } });
  const digest = harness.calls.apply.at(-1).actions[0];
  assert.equal(digest.operation, "digest");
  assert.equal(digest.digestKind, "morning");
  assert.equal(digest.time, "09:00");

  harness.state.settings = settingsRow({ version: 9 });
  await harness.patch("/settings", { expectedVersion: 9, change: { operation: "weekly_preset", enabled: true } });
  const weekly = harness.calls.apply.at(-1).actions[0];
  assert.equal(weekly.operation, "weekly_review");
  assert.equal(weekly.weekday, 7);
  assert.equal(weekly.time, "20:00");

  // «Утром» resolves against the morning reference time, and that resolution lives in one place.
  harness.state.settings = settingsRow({ version: 11 });
  const applies = harness.calls.apply.length;
  const morning = await harness.patch("/settings", { expectedVersion: 11, change: { operation: "snooze", until: { kind: "morning" } } });
  assert.equal(morning.status, 200);
  assert.equal(harness.calls.snoozeUntilMorning, 1);
  assert.equal(harness.calls.apply.length, applies, "it is the same unjournaled write /snooze morning performs");
  assert.equal(SettingsResponseSchema.parse(morning.body.settings).notificationsSnoozedUntil, "2026-09-06T06:00:00.000Z");
});

test("a journaled settings change hands back the group Undo needs, and the two that are not hand back null", async (t) => {
  // The bot attaches an Undo button to every settings change it makes in chat. A screen that could
  // not reach the group would be a feature lost in the move, and the two exceptions are exactly the
  // two writes that skip the journal.
  const harness = await createApp();
  t.after(() => harness.close());

  const language = await harness.patch("/settings", { expectedVersion: 7, change: { operation: "language", language: "uk" } });
  assert.equal(language.status, 200);
  assert.equal(SettingsMutationResponseSchema.parse(language.body).undoGroupId, GROUP_ID);

  // «Утром» is written straight through `SettingsService`: no action group, so nothing to undo.
  harness.state.settings = settingsRow({ version: 9 });
  const morning = await harness.patch("/settings", { expectedVersion: 9, change: { operation: "snooze", until: { kind: "morning" } } });
  assert.equal(SettingsMutationResponseSchema.parse(morning.body).undoGroupId, null);

  // A timezone applied to the digests alone is a journaled action *plus* an unjournaled column
  // copy. Undoing the action would restore the profile zone and leave the copied one — a half-undo,
  // and the reason the answer refuses to offer it.
  harness.state.settings = settingsRow({ version: 11 });
  const copied = await harness.patch("/settings", { expectedVersion: 11, change: { operation: "timezone", timezone: "Europe/Berlin", applyTo: "digests" } });
  assert.equal(harness.calls.applyProfileTimezone.length, 1);
  assert.equal(SettingsMutationResponseSchema.parse(copied.body).undoGroupId, null);

  // «Обе» is one step that moves all three columns, so it is undoable in full.
  harness.state.settings = settingsRow({ version: 13 });
  const both = await harness.patch("/settings", { expectedVersion: 13, change: { operation: "timezone", timezone: "Europe/Berlin", applyTo: "both" } });
  assert.equal(SettingsMutationResponseSchema.parse(both.body).undoGroupId, GROUP_ID);
});

test("the timezone picker searches server-side, in the words /timezone accepts", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.get("/settings/timezones?q=%D0%BA%D0%B8%D0%B5%D0%B2");
  assert.equal(status, 200);
  const parsed = TimezoneSearchResponseSchema.parse(body);
  assert.equal(parsed.suggestions[0]?.id, "Europe/Kyiv");
  assert.match(parsed.suggestions[0].localTime, /^\d{2}:\d{2}$/u);
  assert.ok(Number.isInteger(parsed.suggestions[0].offsetMinutes));

  const byId = TimezoneSearchResponseSchema.parse((await harness.get("/settings/timezones?q=Berlin")).body);
  assert.ok(
    byId.suggestions.some((suggestion) => suggestion.id === "Europe/Berlin"),
    "a substring of the IANA id finds it too",
  );

  assert.deepEqual(TimezoneSearchResponseSchema.parse((await harness.get("/settings/timezones?q=zzzzzz")).body).suggestions, []);
  assert.equal((await harness.get("/settings/timezones")).status, 400, "the query is required");
});

/* ------------------------------------------------------------------ consent */

test("consent grants and revocations follow the pairing the chat enforces", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const initial = ConsentResponseSchema.parse((await harness.get("/consent")).body);
  assert.deepEqual(
    initial.consents.map((consent) => [consent.scope, consent.granted]),
    [
      ["text", false],
      ["voice", false],
    ],
  );

  // Voice needs both: a transcription and a model turn. Granting one alone would leave a screen
  // that says yes and a `voiceGate` that still refuses.
  const granted = ConsentResponseSchema.parse((await harness.post("/consent/grant", { scope: "voice" })).body);
  assert.deepEqual(harness.calls.consent, ["grant:voice"]);
  assert.deepEqual(
    granted.consents.map((consent) => consent.granted),
    [true, true],
  );
  assert.equal(granted.consents[0].version, "2");

  // Revoking text revokes both — what /ai_revoke does — because voice cannot outlive it.
  await harness.post("/consent/revoke", { scope: "text" });
  assert.equal(harness.calls.consent.at(-1), "revoke:text");
  // Revoking voice touches OpenAI alone.
  await harness.post("/consent/revoke", { scope: "voice" });
  assert.equal(harness.calls.consent.at(-1), "revoke:openai");

  assert.equal((await harness.post("/consent/grant", { scope: "everything" })).status, 400);
});

test("clearing the AI history says how much it forgot, and forgets nothing else", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.post("/chat/history/clear");
  assert.equal(status, 200);
  assert.deepEqual(body, { cleared: 9 });
  assert.equal(harness.calls.cleared, 1);
});

/* ------------------------------------------------------------------ account */

test("account deletion needs the literal word, and says the way back is the chat", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const refused = await harness.post("/account/delete", { confirm: "yes" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, "validation_failed");
  assert.equal(harness.calls.requestDeletion.length, 0);

  assert.equal((await harness.post("/account/delete", {})).status, 400);
  assert.equal(harness.calls.requestDeletion.length, 0);

  const { status, body } = await harness.post("/account/delete", { confirm: "delete" });
  assert.equal(status, 200);
  assert.equal(body.deleteAfter, "2026-09-19T06:00:00.000Z");
  assert.equal(body.graceDays, 14);
  // Not a capability flag: the deletion screen has to render the sentence, because the guard
  // refuses a deletion-pending user and /restore is the only way back.
  assert.equal(body.restoreIsChatOnly, true);
  assert.deepEqual(harness.calls.requestDeletion, [OWNER_TELEGRAM_ID]);
});

/* ------------------------------------------------------------------ memory */

test("GET /memory shows everything, sensitive entries included, with the version a write needs", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.get("/memory");
  assert.equal(status, 200);
  const parsed = MemoryResponseSchema.parse(body);
  assert.equal(parsed.page.total, 3);
  assert.equal(parsed.sensitiveCount, 1);
  const sensitive = parsed.rows.find((row) => row.id === SENSITIVE_ID);
  assert.ok(sensitive, "a sensitive fact is hidden from the model, not from its owner");
  assert.equal(sensitive.sensitive, true);
  assert.equal(sensitive.version, 1, "the version the PATCH will be checked against travels with the row");
  assert.equal(sensitive.source, "user_explicit");

  const filtered = MemoryResponseSchema.parse((await harness.get("/memory?type=context")).body);
  assert.deepEqual(
    filtered.rows.map((row) => row.id),
    [CONTEXT_ID],
  );
});

test("the memory list is a page of the whole table, not the newest window of it", async (t) => {
  // Every row on this screen is editable and deletable, so a read that stopped at a cap would make
  // the rows past it permanently uncorrectable — and `sensitiveCount` would count only what fit.
  const base = memoryRows()[0];
  const many = Array.from({ length: 7 }, (_, index) => ({
    ...base,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    sensitive: index >= 5,
    version: index + 1,
  }));
  const harness = await createApp({ memory: many });
  t.after(() => harness.close());

  const first = MemoryResponseSchema.parse((await harness.get("/memory?pageSize=3")).body);
  assert.equal(first.rows.length, 3);
  assert.deepEqual(first.page, { page: 0, pages: 3, pageSize: 3, total: 7, hasMore: true });
  assert.equal(first.sensitiveCount, 2, "counted over the filter, not over the page that loaded");

  // The last page is reachable, and its rows carry the version a PATCH or a DELETE is checked
  // against — so a fact older than one window can still be corrected.
  const last = MemoryResponseSchema.parse((await harness.get("/memory?page=2&pageSize=3")).body);
  assert.deepEqual(last.page, { page: 2, pages: 3, pageSize: 3, total: 7, hasMore: false });
  assert.equal(last.rows.length, 1);
  assert.equal(last.rows[0].version, 7);
  assert.equal(last.sensitiveCount, 2);

  // A page past the end clamps to the last one rather than answering an empty list in the middle
  // of an infinite scroll.
  const past = MemoryResponseSchema.parse((await harness.get("/memory?page=9&pageSize=3")).body);
  assert.equal(past.page.page, 2);
  assert.equal(past.rows.length, 1);
});

test("a memory id from another workspace is the same not-found as an id that never existed", async (t) => {
  const harness = await createApp({ memory: [{ ...memoryRows()[0], workspaceId: "11112222-3333-4444-8555-666677778888" }] });
  t.after(() => harness.close());

  const foreign = await harness.get("/memory");
  assert.deepEqual(MemoryResponseSchema.parse(foreign.body).rows, [], "the list is scoped, not filtered client-side");

  const stranger = await harness.patch(`/memory/${MEMORY_ID}`, { expectedVersion: 3, content: "нет", type: null, sensitive: null, confirmSensitive: false });
  const ghost = await harness.patch("/memory/00000000-0000-4000-8000-000000000000", { expectedVersion: 1, content: "нет", type: null, sensitive: null, confirmSensitive: false });
  assert.equal(stranger.status, 404);
  assert.deepEqual(stranger.body, ghost.body, "a foreign id must be indistinguishable from a missing one");
  assert.equal(harness.calls.apply.length, 0);
});

test("a sensitive fact cannot be edited, marked or deleted without saying so", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const unconfirmed = await harness.patch(`/memory/${SENSITIVE_ID}`, { expectedVersion: 1, content: "другой текст", type: null, sensitive: null, confirmSensitive: false });
  assert.equal(unconfirmed.status, 422);
  assert.deepEqual(unconfirmed.body.error.details, { kind: "rule", rule: "sensitive_confirmation_required" });
  assert.equal(harness.calls.apply.length, 0);

  // Marking an ordinary fact sensitive is the same gate from the other side.
  const marking = await harness.patch(`/memory/${MEMORY_ID}`, { expectedVersion: 3, content: null, type: null, sensitive: true, confirmSensitive: false });
  assert.equal(marking.status, 422);
  assert.equal(harness.calls.apply.length, 0);

  const deleting = await harness.del(`/memory/${SENSITIVE_ID}`, { expectedVersion: 1, confirmSensitive: false });
  assert.equal(deleting.status, 422);
  assert.equal(harness.calls.apply.length, 0);

  const confirmed = await harness.patch(`/memory/${SENSITIVE_ID}`, { expectedVersion: 1, content: "исправленный текст", type: null, sensitive: null, confirmSensitive: true });
  assert.equal(confirmed.status, 200);
  const [action] = harness.calls.apply.at(-1).actions;
  assert.equal(action.type, "memory", "the write is the same journaled action the model's edit takes");
  assert.equal(action.op, "update");
  assert.equal(action.memoryId, SENSITIVE_ID);
  assert.equal(action.memoryVersion, 1);
  assert.equal(confirmed.body.undoGroupId, GROUP_ID, "and it is undoable, because it went through the journal");
});

test("DELETE /memory/:id fails loudly when its body does not arrive", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  // The body carries the version and the confirmation. A proxy that strips it must produce a
  // refusal, never a deletion with neither.
  const stripped = await harness.del(`/memory/${SENSITIVE_ID}`);
  assert.equal(stripped.status, 400);
  assert.equal(stripped.body.error.code, "validation_failed");
  assert.equal(harness.calls.apply.length, 0);

  // A body that arrives but says nothing names the fields it is missing, which is the difference
  // between «your proxy ate this» and «you forgot the confirmation».
  const empty = await harness.del(`/memory/${SENSITIVE_ID}`, {});
  assert.equal(empty.status, 400);
  assert.deepEqual(new Set(empty.body.error.details.fields), new Set(["expectedVersion", "confirmSensitive"]));
  assert.equal(harness.calls.apply.length, 0);

  const deleted = await harness.del(`/memory/${MEMORY_ID}`, { expectedVersion: 3, confirmSensitive: false });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.item, null);
  assert.equal(deleted.body.undoGroupId, GROUP_ID);
  assert.equal(harness.calls.apply.at(-1).actions[0].op, "delete");
});

test("a memory patch that changes nothing, or changes the kind, is refused rather than half-applied", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const empty = await harness.patch(`/memory/${MEMORY_ID}`, { expectedVersion: 3, content: null, type: null, sensitive: null, confirmSensitive: false });
  assert.equal(empty.status, 400);

  // `update_memory` patches content and sensitivity only: accepting `type` and dropping it would
  // bump the version and journal a change that did not happen.
  const retyped = await harness.patch(`/memory/${MEMORY_ID}`, { expectedVersion: 3, content: null, type: "decision", sensitive: null, confirmSensitive: false });
  assert.equal(retyped.status, 422);
  assert.deepEqual(retyped.body.error.details, { kind: "rule", rule: "memory_type_immutable" });
  assert.equal(harness.calls.apply.length, 0);
});

test("GET /profile is the context entries and the invitation stamp, not a second store", async (t) => {
  const harness = await createApp({ settings: { profileInvitedAt: new Date("2026-04-04T04:04:04.000Z") } });
  t.after(() => harness.close());

  const { status, body } = await harness.get("/profile");
  assert.equal(status, 200);
  const parsed = ProfileResponseSchema.parse(body);
  assert.deepEqual(
    parsed.rows.map((row) => row.id),
    [CONTEXT_ID],
  );
  assert.equal(parsed.invitedAt, "2026-04-04T04:04:04.000Z");
});

/* ------------------------------------------------------------------ reminders */

test("GET /reminders groups by the task's own day and says when notifications are snoozed", async (t) => {
  const harness = await createApp({ settings: { notificationsSnoozedUntil: new Date("2026-09-09T20:00:00.000Z") } });
  t.after(() => harness.close());

  const { status, body } = await harness.get("/reminders");
  assert.equal(status, 200);
  const parsed = RemindersResponseSchema.parse(body);
  assert.equal(parsed.rows.length, 1);
  const [row] = parsed.rows;
  assert.equal(row.deliveryId, DELIVERY_ID);
  assert.equal(row.title, "Позвонить в банк");
  assert.equal(row.timezone, "Europe/Kyiv");
  // 06:00Z is 09:00 in Kyiv on that date, so the day heading is the 10th — computed here, with the
  // row's own zone, rather than in a browser that may be set to anything.
  assert.equal(row.localDate, "2026-09-10");
  assert.equal(row.purpose, "user_reminder");
  assert.equal(row.followUp, false);
  // A snooze delays delivery; the rows below it are still scheduled, and hiding them would read as
  // «the reminders are gone».
  assert.equal(parsed.notificationsSnoozedUntil, "2026-09-09T20:00:00.000Z");
  assert.equal(parsed.page.total, 1);
});

test("a follow-up created by «отложить» is marked as one", async (t) => {
  const row = deliveryRow();
  const harness = await createApp({ deliveries: [{ ...row, rule: { purpose: "follow_up", origin: "system" } }] });
  t.after(() => harness.close());

  const parsed = RemindersResponseSchema.parse((await harness.get("/reminders")).body);
  assert.equal(parsed.rows[0].purpose, "follow_up");
  assert.equal(parsed.rows[0].followUp, true);
});

test("a delivery id from another workspace answers not-found, for every verb", async (t) => {
  const harness = await createApp({ deliveries: [] });
  t.after(() => harness.close());

  const cases = [
    await harness.post(`/reminders/${DELIVERY_ID}/snooze`, { choice: "1h" }),
    await harness.post(`/reminders/${DELIVERY_ID}/repeat`, { date: "2026-09-11", time: "10:00" }),
    await harness.del(`/reminders/${DELIVERY_ID}`),
  ];
  for (const result of cases) {
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: { code: "not_found", message: "Not found" } });
  }
  assert.equal(harness.calls.followUp.length, 0);
  assert.equal(harness.calls.cancelUpcoming.length, 0, "nothing is attempted before the id is known to belong here");
});

test("a delivery beyond the list window is still snoozable, repeatable and cancellable", async (t) => {
  // The list reads the soonest `WINDOW` deliveries. Looking a delivery up by scanning that list
  // made the `WINDOW + 1`st unreachable for every write, even though `cancelUpcoming` would have
  // performed it — a read cap that reaches into the write path is a row that cannot be changed.
  const far = deliveryRow();
  far.delivery = { ...far.delivery, id: "3f2e1d0c-9b8a-4756-8443-2211ffeeddcc" };
  const filler = Array.from({ length: 250 }, (_, index) => {
    const row = deliveryRow();
    row.delivery = { ...row.delivery, id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, occurrenceId: null };
    return row;
  });
  const harness = await createApp({ deliveries: [...filler, far], followUpResult: far.delivery.id });
  t.after(() => harness.close());

  const listed = RemindersResponseSchema.parse((await harness.get("/reminders?pageSize=50")).body);
  assert.equal(listed.page.total, 200, "the list stops at the window, which is what it is for");
  assert.equal(
    listed.rows.some((row) => row.deliveryId === far.delivery.id),
    false,
  );

  const snoozed = await harness.post(`/reminders/${far.delivery.id}/snooze`, { choice: "1h" });
  assert.equal(snoozed.status, 200, "a delivery the list could not reach is still addressable by id");
  assert.deepEqual(harness.calls.followUp.at(-1).occurrenceId, OCCURRENCE_ID);

  const cancelled = await harness.del(`/reminders/${far.delivery.id}`);
  assert.equal(cancelled.status, 200);
  assert.deepEqual(harness.calls.cancelUpcoming.at(-1), { workspaceId: WORKSPACE_ID, userId: USER_ID, deliveryId: far.delivery.id });
});

test("snoozing repeats the contact without journaling a state change", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.post(`/reminders/${DELIVERY_ID}/snooze`, { choice: "15m" });
  assert.equal(status, 200);
  assert.deepEqual(harness.calls.followUp, [{ workspaceId: WORKSPACE_ID, userId: USER_ID, occurrenceId: OCCURRENCE_ID, choice: "15m" }]);
  // No state changed, so there is nothing truthful for Undo to restore. A group id here would be a
  // button that promises a rollback it cannot perform.
  assert.equal(body.undoGroupId, null);
  assert.equal(harness.calls.apply.length, 0);

  harness.state.followUpResult = null;
  const terminal = await harness.post(`/reminders/${DELIVERY_ID}/snooze`, { choice: "1h" });
  assert.equal(terminal.status, 422, "an occurrence that has finished is a domain refusal, not a failure");
  assert.deepEqual(terminal.body.error.details, { kind: "rule", rule: "occurrence_terminal" });

  assert.equal((await harness.post(`/reminders/${DELIVERY_ID}/snooze`, { choice: "3h" })).status, 400);
});

test("repeating at a named time is a journaled reminder on the occurrence", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.post(`/reminders/${DELIVERY_ID}/repeat`, { date: "2026-09-11", time: "10:15" });
  assert.equal(status, 200);
  const [action] = harness.calls.apply.at(-1).actions;
  assert.equal(action.type, "set_reminder");
  assert.equal(action.mode, "add");
  assert.deepEqual(action.reminder, { kind: "at", date: "2026-09-11", time: "10:15", quiet: "respect" });
  assert.deepEqual(action.target, {
    kind: "occurrence",
    taskId: TASK_ID,
    taskVersion: 4,
    occurrenceId: OCCURRENCE_ID,
    occurrenceVersion: 2,
    timezone: "Europe/Kyiv",
  });
  assert.equal(body.undoGroupId, GROUP_ID);

  // The rules that refuse a past time, a time inside quiet hours and two reminders closer than
  // fifteen minutes live in the domain; the API surfaces their code and writes nothing.
  harness.state.issues = [{ kind: "domain", index: 0, code: "time_past", message: "reminder must be in the future" }];
  const applies = harness.calls.apply.length;
  const refused = await harness.post(`/reminders/${DELIVERY_ID}/repeat`, { date: "2020-01-01", time: "10:15" });
  assert.equal(refused.status, 422);
  assert.deepEqual(refused.body.error.details, { kind: "rule", rule: "time_past" });
  assert.equal(harness.calls.apply.length, applies);
});

test("cancelling one delivery leaves the rule alone and answers the race honestly", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const cancelled = await harness.del(`/reminders/${DELIVERY_ID}`);
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.body, { cancelled: true });
  assert.deepEqual(harness.calls.cancelUpcoming, [{ workspaceId: WORKSPACE_ID, userId: USER_ID, deliveryId: DELIVERY_ID }]);

  // It stopped being pending between the list and the tap: the bot answers «уже отправлено» to the
  // same race, and so does this.
  harness.state.cancelResult = false;
  assert.deepEqual((await harness.del(`/reminders/${DELIVERY_ID}`)).body, { cancelled: false });
});

/* ------------------------------------------------------------------ helpers */

/** A Drizzle-shaped object where every chain is legal and every await yields no rows. */
function inertDb() {
  const chain = () =>
    new Proxy(function () {}, {
      get: (_target, property) => (property === "then" ? (resolve) => resolve([]) : chain()),
      apply: () => chain(),
    });
  return chain();
}
