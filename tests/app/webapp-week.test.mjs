import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import "reflect-metadata";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { AccessService } from "../../dist/access/access.service.js";
import { ActionsService } from "../../dist/actions/actions.service.js";
import { AiService } from "../../dist/ai/ai.service.js";
import { ApiIpRateLimiter, ApiUserRateLimiter } from "../../dist/api/auth/rate-limiter.js";
import { WeekPickResponseSchema, WeekResponseSchema, WeekTakeTodayResponseSchema } from "../../dist/api/contracts/index.js";
import { ApiExceptionFilter } from "../../dist/api/http/api-exception.filter.js";
import { WebWeekModule } from "../../dist/api/week/web-week.module.js";
import { ChatService } from "../../dist/chat/chat.service.js";
import { APP_CONFIG } from "../../dist/config.js";
import { comparePoolRows, targetWeekStart, WEEK_PICK_LIMIT } from "../../dist/core/week-plan.js";
import { DatabaseService } from "../../dist/database/database.service.js";
import { JobQueueService } from "../../dist/queue/job-queue.service.js";
import { SettingsService } from "../../dist/settings/settings.service.js";
import { TasksService } from "../../dist/tasks/tasks.service.js";
import { TelegramService } from "../../dist/telegram/telegram.service.js";

/**
 * The week plan over a real socket.
 *
 * The subject is the one value the whole screen turns on: the Monday of the week a pick made *now*
 * is for. It is derived from the instant and from the timezone on the user's settings row, and both
 * halves of that are easy to get wrong in ways no reviewer sees — a server that reads UTC, or one
 * that assumes a timezone's offset never moves. There is a Saturday night in Santiago where the two
 * mistakes disagree with the truth by a whole week, and it is the fixture below.
 *
 * The second subject is the mark itself: a pick names the week it was made for, so a pick that was
 * never acted on is still readable next week as the decision that was avoided. Nothing clears it,
 * which means `stale` has to be true for exactly one week and `picked` false the whole time.
 *
 * Everything below the controller is a faithful fake — `togglePickedForWeek` keeps the cap and the
 * same-week reversal, and nothing else — because the repository's transaction is `tests/e2e`'s job.
 * What is real here is the guard, the router, the error envelope, and the controller's own reading
 * of the clock.
 */

const BOT_TOKEN = "123456:AA-test-bot-token-not-a-real-one";
const TELEGRAM_ID = 909_090;

const USER_ID = "2e1d0c9b-8a77-4655-9443-2211ffeeddcc";
const WORKSPACE_ID = "aa11bb22-cc33-4d44-8e55-ff6677889900";
/** Another workspace's task. It exists; it must be as invisible as an id that never did. */
const OTHER_WORKSPACE_ID = "bb22cc33-dd44-4e55-8f66-001122334455";

const CONFIG = {
  nodeEnv: "test",
  appCommit: "week-test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused/unused",
  telegramBotToken: BOT_TOKEN,
  botIdentity: "webapp-week-test",
  ownerTelegramUserId: TELEGRAM_ID,
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
  user: { id: USER_ID, telegramUserId: TELEGRAM_ID, status: "active", aiStatus: "enabled" },
  workspaceId: WORKSPACE_ID,
};

/**
 * The Saturday night Chile leaves DST: at 03:00Z on 5 April the clocks go back from 24:00 to 23:00,
 * so this instant is 23:30 on **Saturday** the 4th in Santiago.
 *
 * Three answers are possible and only one is right:
 *
 * | read as                            | local day        | target Monday |
 * | ---------------------------------- | ---------------- | ------------- |
 * | Santiago, offset now in force (-4) | Sat 2026-04-04   | 2026-03-30    |
 * | Santiago, yesterday's offset (-3)  | Sun 2026-04-05   | 2026-04-06    |
 * | UTC                                | Sun 2026-04-05   | 2026-04-06    |
 *
 * A week apart, from one hour of offset. The Sunday rule is what magnifies it: on a Sunday a pick
 * is for *tomorrow's* Monday, so misreading the day by one misreads the week by seven.
 */
const DST_INSTANT = "2026-04-05T03:30:00.000Z";
const DST_TIMEZONE = "America/Santiago";
const DST_TODAY = "2026-04-04";
const DST_WEEK_START = "2026-03-30";
/** What UTC and the stale offset would both have said. Named so the assertions can rule it out. */
const DST_WRONG_WEEK_START = "2026-04-06";

const SETTINGS_ROW = {
  userId: USER_ID,
  timezone: DST_TIMEZONE,
  digestTimezone: DST_TIMEZONE,
  quietHoursTimezone: DST_TIMEZONE,
  pinnedLanguage: null,
  telegramLanguage: "ru",
  quietHoursEnabled: false,
  weekdayQuietStart: "22:00",
  weekdayQuietEnd: "08:00",
  weekendQuietStart: "23:00",
  weekendQuietEnd: "09:00",
  notificationsSnoozedUntil: null,
  morningReferenceTime: "07:30",
  eveningReferenceTime: "20:00",
  morningDigestEnabled: true,
  weeklyReviewEnabled: true,
  weeklyReviewWeekday: 7,
  weeklyReviewTime: "20:00",
  onboardingCompletedAt: new Date("2026-01-02T03:04:05.000Z"),
  eventReminderOffsetsMinutes: [-60, -15],
  plannedTaskReminderOffsetMinutes: 0,
  criticalPostDueMinutes: 60,
  seenNormalMinutes: 60,
  seenRequiredMinutes: 30,
  seenCriticalMinutes: 15,
  version: 3,
};

/* ------------------------------------------------------------------ fixtures */

function id(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A pool task. `pool` mirrors `POOL_MEMBERSHIP`: dateless, or a one-off whose day has passed. */
function poolTask(n, overrides = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    id: id(n),
    version: 1,
    title: `task ${String(n).padStart(2, "0")}`,
    importance: "normal",
    pickedWeekStart: null,
    overdue: false,
    status: "active",
    timeMode: "fuzzy",
    timezone: DST_TIMEZONE,
    pool: true,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ harness */

function sign(fields) {
  const dataCheckString = Object.keys(fields)
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  return createHmac("sha256", secret).update(dataCheckString).digest("hex");
}

/**
 * A signed payload. `auth_date` is read against the real clock inside `verifyInitData`, and the
 * tests below freeze the clock at a date in 2026 — so it is minted from the frozen instant too,
 * rather than from whatever day this suite happens to run on.
 */
function initData(nowMs) {
  const fields = {
    user: JSON.stringify({ id: TELEGRAM_ID, first_name: "Week", username: "week", language_code: "ru" }),
    chat_instance: "-1234567890123456789",
    chat_type: "sender",
    auth_date: String(Math.floor(nowMs / 1000)),
  };
  const signed = { ...fields, hash: sign(fields) };
  return Object.entries(signed)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

/**
 * The clock, held still for the duration of one request.
 *
 * `new Date()` is the controller's only reading of it and there is no seam to inject through, so
 * the constructor itself is replaced. `Intl` still resolves the offset in force at that instant,
 * which is exactly the behaviour under test.
 */
async function atInstant(iso, work) {
  const Real = globalThis.Date;
  const fixed = Real.parse(iso);
  class Frozen extends Real {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = Frozen;
  try {
    return await work(fixed);
  } finally {
    globalThis.Date = Real;
  }
}

async function createApp(options = {}) {
  const state = {
    tasks: (options.tasks ?? []).map((task) => ({ ...task })),
    settings: { ...SETTINGS_ROW, ...(options.settings ?? {}) },
    summary: options.summary ?? { done: 4, takenNotStarted: 2 },
    occurrenceId: options.occurrenceId ?? "9f8e7d6c-5b4a-4392-8281-706f5e4d3c2b",
  };
  const calls = { plan: [], toggle: [], getTask: [], poolTask: [], validated: [], applied: [] };

  const tasks = {
    async listWeekPlanForTelegram(workspaceId, todayLocalDate) {
      calls.plan.push({ workspaceId, todayLocalDate });
      const rows = state.tasks.filter((task) => task.workspaceId === workspaceId && task.status === "active" && task.pool);
      return {
        rows: [...rows].sort(comparePoolRows(todayLocalDate)),
        total: rows.length,
        summary: state.summary,
        weekStart: targetWeekStart(todayLocalDate),
      };
    },
    /** The repository's semantics, and no more: same-week mark reverses, otherwise the cap holds. */
    async togglePickedForWeek(workspaceId, taskId, todayLocalDate) {
      calls.toggle.push({ workspaceId, taskId, todayLocalDate });
      const weekStart = targetWeekStart(todayLocalDate);
      const task = state.tasks.find((row) => row.workspaceId === workspaceId && row.id === taskId && row.status === "active" && row.pool);
      if (!task) return null;
      if (task.pickedWeekStart === weekStart) {
        task.pickedWeekStart = null;
        return "released";
      }
      const picked = state.tasks.filter((row) => row.workspaceId === workspaceId && row.status === "active" && row.pool && row.pickedWeekStart === weekStart).length;
      if (picked >= WEEK_PICK_LIMIT) return "full";
      task.pickedWeekStart = weekStart;
      return "picked";
    },
    async getTask(workspaceId, taskId) {
      calls.getTask.push({ workspaceId, taskId });
      return state.tasks.find((row) => row.workspaceId === workspaceId && row.id === taskId) ?? null;
    },
    /**
     * `POOL_MEMBERSHIP` for one id, which is what the controller asks now — dateless *or* a one-off
     * whose day has passed. The fake's `pool` flag is the same predicate the list above filters on,
     * so a row the pool showed is a row this returns.
     */
    async findPoolTask(workspaceId, taskId) {
      calls.poolTask.push({ workspaceId, taskId });
      return state.tasks.find((row) => row.workspaceId === workspaceId && row.id === taskId && row.status === "active" && row.pool) ?? null;
    },
    async findCurrentOccurrence(workspaceId, taskId) {
      const task = state.tasks.find((row) => row.workspaceId === workspaceId && row.id === taskId);
      return task && task.dated ? { id: state.occurrenceId, version: task.occurrenceVersion ?? 1, timezone: task.timezone } : null;
    },
    async findCurrentOccurrences() {
      return new Map();
    },
  };

  const actions = {
    async validateResolved(resolved, scope) {
      calls.validated.push({ actions: resolved, scope });
      return options.issues ?? [];
    },
    async applyResolved(resolved, scope) {
      calls.applied.push({ actions: resolved, scope });
      if (options.applyFails) throw options.applyFails;
      // The real thing gives a dateless task its first occurrence in the same transaction.
      for (const action of resolved) {
        const task = state.tasks.find((row) => row.workspaceId === scope.workspaceId && row.id === action.target.taskId);
        if (task) {
          task.dated = true;
          task.timeMode = "point";
          task.pool = false;
          task.version += 1;
        }
      }
      return { groupId: "7c6b5a49-3827-4160-9f0e-1d2c3b4a5968", count: resolved.length, titles: [], items: [] };
    },
  };

  const moduleRef = await Test.createTestingModule({
    imports: [WebWeekModule],
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
    .useValue({ resolveActiveUser: async (telegramUserId) => (telegramUserId === TELEGRAM_ID ? ACTIVE_ACCESS : null), findRestorable: async () => null })
    .overrideProvider(AiService)
    .useValue({
      providerName: "openai",
      consentVersion: CONFIG.aiConsentVersion,
      maxCallsPerHour: CONFIG.aiMaxCallsPerHour,
      isConfigured: () => true,
      hasConsent: async () => true,
      hasProviderConsent: async () => true,
      callsLastHour: async () => 0,
      onApplicationBootstrap: () => undefined,
    })
    .overrideProvider(ChatService)
    .useValue({ providerName: "openai", isAiConfigured: () => true, historyMessageCount: async () => 0 })
    .overrideProvider(TasksService)
    .useValue(tasks)
    .overrideProvider(ActionsService)
    .useValue(actions)
    .compile();

  const settingsService = moduleRef.get(SettingsService, { strict: false });
  settingsService.get = async () => state.settings;

  const app = moduleRef.createNestApplication();
  app.set("trust proxy", 1);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address();
  app.get(ApiIpRateLimiter).reset();
  app.get(ApiUserRateLimiter).reset();

  let address = 0;
  return {
    state,
    calls,
    /** One request, with the clock held at `instant` for the whole of it. */
    async call(method, path, { body, instant = DST_INSTANT, authorization } = {}) {
      address += 1;
      return atInstant(instant, async (nowMs) => {
        const headers = { "X-Forwarded-For": `203.0.113.${(address % 200) + 1}` };
        const value = authorization === undefined ? `tma ${initData(nowMs)}` : authorization;
        if (value !== null) headers.Authorization = value;
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() };
      });
    },
    close: () => app.close(),
  };
}

/** Drizzle-shaped and inert: the modules under test reach a repository constructor, never a query. */
function inertDb() {
  const chain = () =>
    new Proxy(function () {}, {
      get: (_target, property) => (property === "then" ? (resolve) => resolve([]) : chain()),
      apply: () => chain(),
    });
  return chain();
}

/* ------------------------------------------------------------------ the week start */

test("the Monday mark is the week start in the user's timezone, on the night the offset moves", async (t) => {
  const harness = await createApp({
    tasks: [poolTask(1), poolTask(2, { pickedWeekStart: DST_WEEK_START })],
  });
  t.after(() => harness.close());

  const { status, body } = await harness.call("GET", "/week");
  assert.equal(status, 200);
  const week = WeekResponseSchema.parse(body);

  // 23:30 on Saturday the 4th in Santiago, because the clocks went back an hour at 03:00Z.
  assert.equal(week.todayLocalDate, DST_TODAY);
  assert.equal(week.timezone, DST_TIMEZONE);
  assert.equal(week.targetWeekStart, DST_WEEK_START);
  assert.notEqual(week.targetWeekStart, DST_WRONG_WEEK_START, "reading the instant in UTC — or with yesterday's offset — moves the week by seven days");
  // The week that just ended is the seven days before the one a pick made now is for.
  assert.deepEqual(week.previousWeek, { start: "2026-03-23", end: "2026-03-29" });

  // And the day the service was asked about is the same one: the mark and the list cannot disagree.
  assert.deepEqual(harness.calls.plan, [{ workspaceId: WORKSPACE_ID, todayLocalDate: DST_TODAY }]);
});

test("the same instant is a different week for a user in a different timezone", async (t) => {
  // The answer comes from the settings row, not from the process. In UTC this instant is already
  // Sunday, and a Sunday pick is for tomorrow's Monday.
  const harness = await createApp({ tasks: [poolTask(1)], settings: { timezone: "UTC" } });
  t.after(() => harness.close());

  const week = WeekResponseSchema.parse((await harness.call("GET", "/week")).body);
  assert.equal(week.todayLocalDate, "2026-04-05");
  assert.equal(week.targetWeekStart, DST_WRONG_WEEK_START);
  assert.deepEqual(week.previousWeek, { start: "2026-03-30", end: "2026-04-05" });
});

test("a pick made on Sunday names tomorrow's Monday, which is why a stale mark is representable", async (t) => {
  const harness = await createApp({ tasks: [poolTask(1)], settings: { timezone: "UTC" } });
  t.after(() => harness.close());

  // Sunday, 2026-04-05 in UTC.
  const sunday = WeekPickResponseSchema.parse((await harness.call("POST", `/week/pick/${id(1)}`)).body);
  assert.equal(sunday.result, "picked");
  assert.equal(sunday.targetWeekStart, "2026-04-06");
  assert.equal(sunday.row.pickedWeekStart, "2026-04-06");
  // Monday arrives and the mark still names the week it was made for, so it is still live.
  const monday = WeekResponseSchema.parse((await harness.call("GET", "/week", { instant: "2026-04-06T12:00:00.000Z" })).body);
  assert.equal(monday.targetWeekStart, "2026-04-06");
  assert.equal(monday.rows[0].picked, true);
  assert.equal(monday.rows[0].stale, false);
});

/* ------------------------------------------------------------------ the stale pick */

test("a pick that was never acted on reads as unfinished for exactly one week", async (t) => {
  const harness = await createApp({
    tasks: [
      poolTask(1, { title: "ordinary" }),
      poolTask(2, { title: "taken last week", pickedWeekStart: "2026-03-23" }),
      poolTask(3, { title: "taken this week", pickedWeekStart: DST_WEEK_START }),
      poolTask(4, { title: "taken long ago", pickedWeekStart: "2026-02-16" }),
    ],
  });
  t.after(() => harness.close());

  const week = WeekResponseSchema.parse((await harness.call("GET", "/week")).body);
  const byTitle = Object.fromEntries(week.rows.map((row) => [row.title, row]));

  // Last week's mark: not picked — the week it named is over — but not gone either. It is the
  // decision that was avoided, and nothing clears it, so the row says so itself.
  assert.deepEqual(
    { picked: byTitle["taken last week"].picked, stale: byTitle["taken last week"].stale, pickedWeekStart: byTitle["taken last week"].pickedWeekStart },
    { picked: false, stale: true, pickedWeekStart: "2026-03-23" },
  );
  assert.deepEqual({ picked: byTitle["taken this week"].picked, stale: byTitle["taken this week"].stale }, { picked: true, stale: false });
  // Older than that stops being news: it is still marked, and it is neither taken nor unfinished.
  assert.deepEqual(
    { picked: byTitle["taken long ago"].picked, stale: byTitle["taken long ago"].stale, pickedWeekStart: byTitle["taken long ago"].pickedWeekStart },
    { picked: false, stale: false, pickedWeekStart: "2026-02-16" },
  );
  assert.deepEqual(
    { picked: byTitle.ordinary.picked, stale: byTitle.ordinary.stale, pickedWeekStart: byTitle.ordinary.pickedWeekStart },
    { picked: false, stale: false, pickedWeekStart: null },
  );

  // Only a live pick counts against the limit; the stale one does not quietly occupy a slot.
  assert.equal(week.pickedCount, 1);
  assert.equal(week.pickLimit, WEEK_PICK_LIMIT);
  // And the avoided decision is at the top, where the pick screen puts it.
  assert.equal(week.rows[0].title, "taken last week");
});

test("the pool leads with the day that has already passed, and pages without reordering", async (t) => {
  const tasks = [
    poolTask(1, { title: "overdue one", overdue: true, timeMode: "point" }),
    poolTask(2, { title: "stale one", pickedWeekStart: "2026-03-23" }),
    poolTask(3, { title: "critical one", importance: "critical" }),
    poolTask(4, { title: "plain one" }),
  ];
  const harness = await createApp({ tasks });
  t.after(() => harness.close());

  const week = WeekResponseSchema.parse((await harness.call("GET", "/week")).body);
  assert.deepEqual(
    week.rows.map((row) => row.title),
    ["overdue one", "stale one", "critical one", "plain one"],
  );
  assert.equal(week.rows[0].overdue, true);
  assert.deepEqual(week.page, { page: 0, pages: 1, pageSize: 30, total: 4, hasMore: false });

  const first = WeekResponseSchema.parse((await harness.call("GET", "/week?page=0&pageSize=2")).body);
  assert.deepEqual(
    first.rows.map((row) => row.title),
    ["overdue one", "stale one"],
  );
  assert.deepEqual(first.page, { page: 0, pages: 2, pageSize: 2, total: 4, hasMore: true });

  const second = WeekResponseSchema.parse((await harness.call("GET", "/week?page=1&pageSize=2")).body);
  assert.deepEqual(
    second.rows.map((row) => row.title),
    ["critical one", "plain one"],
  );
  assert.equal(second.page.hasMore, false);
  // A page past the end clamps rather than inventing one, so an infinite list stops instead of looping.
  const past = WeekResponseSchema.parse((await harness.call("GET", "/week?page=9&pageSize=2")).body);
  assert.equal(past.page.page, 1);
  assert.equal(past.page.hasMore, false);
});

test("the past week is reported as the domain summarised it", async (t) => {
  const harness = await createApp({ tasks: [poolTask(1)], summary: { done: 11, takenNotStarted: 3 } });
  t.after(() => harness.close());

  const week = WeekResponseSchema.parse((await harness.call("GET", "/week")).body);
  assert.deepEqual(week.summary, { done: 11, takenNotStarted: 3 });
});

/* ------------------------------------------------------------------ pick and release */

test("the pick and the release are verbs, not the button's toggle", async (t) => {
  const harness = await createApp({ tasks: [poolTask(1)] });
  t.after(() => harness.close());

  const picked = WeekPickResponseSchema.parse((await harness.call("POST", `/week/pick/${id(1)}`)).body);
  assert.equal(picked.result, "picked");
  assert.equal(picked.row.picked, true);
  assert.equal(picked.row.pickedWeekStart, DST_WEEK_START);
  assert.equal(picked.pickedCount, 1);
  assert.equal(picked.targetWeekStart, DST_WEEK_START);

  // The same verb again. A toggle behind POST would release it here, which is exactly the bug a
  // checkbox in a browser would hit the moment two taps raced.
  const again = WeekPickResponseSchema.parse((await harness.call("POST", `/week/pick/${id(1)}`)).body);
  assert.equal(again.result, "picked");
  assert.equal(again.row.picked, true);
  assert.equal(again.pickedCount, 1);
  assert.equal(harness.calls.toggle.length, 1, "asking for the state a row is already in writes nothing");

  const released = WeekPickResponseSchema.parse((await harness.call("DELETE", `/week/pick/${id(1)}`)).body);
  assert.equal(released.result, "released");
  assert.equal(released.row.picked, false);
  assert.equal(released.row.pickedWeekStart, null);
  assert.equal(released.pickedCount, 0);

  const releasedAgain = WeekPickResponseSchema.parse((await harness.call("DELETE", `/week/pick/${id(1)}`)).body);
  assert.equal(releasedAgain.result, "released");
  assert.equal(harness.calls.toggle.length, 2);
});

test("taking a stale row for the coming week re-marks it, and the row stops being unfinished", async (t) => {
  const harness = await createApp({ tasks: [poolTask(1, { pickedWeekStart: "2026-03-23" })] });
  t.after(() => harness.close());

  const picked = WeekPickResponseSchema.parse((await harness.call("POST", `/week/pick/${id(1)}`)).body);
  assert.equal(picked.result, "picked");
  assert.deepEqual({ picked: picked.row.picked, stale: picked.row.stale, mark: picked.row.pickedWeekStart }, { picked: true, stale: false, mark: DST_WEEK_START });
  assert.equal(picked.pickedCount, 1);
});

test("a full week refuses the eighth task without calling it an error", async (t) => {
  const harness = await createApp({
    tasks: [...Array.from({ length: WEEK_PICK_LIMIT }, (_, index) => poolTask(index + 1, { pickedWeekStart: DST_WEEK_START })), poolTask(99, { title: "the eighth" })],
  });
  t.after(() => harness.close());

  const { status, body } = await harness.call("POST", `/week/pick/${id(99)}`);
  // The tap was legal and the limit is a product rule, so the client shows «уже взято 7» rather
  // than a failure. A 4xx here would put a rule in the error channel.
  assert.equal(status, 200);
  const full = WeekPickResponseSchema.parse(body);
  assert.equal(full.result, "full");
  assert.equal(full.row.picked, false, "the row it refused is returned unchanged, so the checkbox can go back");
  assert.equal(full.pickedCount, WEEK_PICK_LIMIT);

  // Releasing one makes room, and the same tap now succeeds.
  assert.equal(WeekPickResponseSchema.parse((await harness.call("DELETE", `/week/pick/${id(1)}`)).body).result, "released");
  assert.equal(WeekPickResponseSchema.parse((await harness.call("POST", `/week/pick/${id(99)}`)).body).result, "picked");
});

test("a task that is no longer in the pool is answered, not raised", async (t) => {
  const harness = await createApp({ tasks: [poolTask(1, { pool: false, timeMode: "point" }), poolTask(2, { status: "closed" })] });
  t.after(() => harness.close());

  for (const taskId of [id(1), id(2)]) {
    const { status, body } = await harness.call("POST", `/week/pick/${taskId}`);
    assert.equal(status, 200);
    const gone = WeekPickResponseSchema.parse(body);
    assert.equal(gone.result, "not_found");
    assert.equal(gone.row, null);
  }
  assert.equal(harness.calls.toggle.length, 0, "a row that is not in the pool is never written to");
});

/* ------------------------------------------------------------------ workspace isolation */

test("a task in another workspace is answered exactly like one that never existed", async (t) => {
  const harness = await createApp({
    tasks: [poolTask(1), poolTask(2, { workspaceId: OTHER_WORKSPACE_ID, title: "not yours", pickedWeekStart: DST_WEEK_START })],
  });
  t.after(() => harness.close());

  const foreign = id(2);
  const absent = "12345678-1234-4123-8123-1234567890ab";

  // It is not in the list at all.
  const week = WeekResponseSchema.parse((await harness.call("GET", "/week")).body);
  assert.deepEqual(
    week.rows.map((row) => row.taskId),
    [id(1)],
  );
  assert.equal(JSON.stringify(week).includes("not yours"), false);

  for (const [method, path] of [
    ["POST", "/week/pick/"],
    ["DELETE", "/week/pick/"],
  ]) {
    const a = await harness.call(method, `${path}${foreign}`);
    const b = await harness.call(method, `${path}${absent}`);
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, b.body, `${method} ${path} must not tell a foreign id apart from an unknown one`);
    assert.equal(a.body.result, "not_found");
  }

  const foreignTake = await harness.call("POST", `/week/take-today/${foreign}`, { body: { expectedVersion: 1 } });
  const absentTake = await harness.call("POST", `/week/take-today/${absent}`, { body: { expectedVersion: 1 } });
  assert.equal(foreignTake.status, 404);
  assert.deepEqual(foreignTake.body, absentTake.body);
  assert.deepEqual(foreignTake.body, { error: { code: "not_found", message: "Not found" } });

  // Nothing was written, and every read the controller made named the caller's workspace.
  assert.equal(harness.calls.toggle.length, 0);
  assert.equal(harness.calls.applied.length, 0);
  assert.equal(harness.state.tasks.find((task) => task.id === foreign).pickedWeekStart, DST_WEEK_START);
  for (const call of [...harness.calls.plan, ...harness.calls.getTask, ...harness.calls.poolTask]) assert.equal(call.workspaceId, WORKSPACE_ID);
});

/* ------------------------------------------------------------------ take today */

test("«делаю сегодня» is the same reschedule the button applies, through the journal", async (t) => {
  const harness = await createApp({ tasks: [poolTask(1, { version: 4, pickedWeekStart: DST_WEEK_START })] });
  t.after(() => harness.close());

  const { status, body } = await harness.call("POST", `/week/take-today/${id(1)}`, { body: { expectedVersion: 4 } });
  assert.equal(status, 200);
  const taken = WeekTakeTodayResponseSchema.parse(body);
  assert.equal(taken.taskId, id(1));
  // Today in the user's timezone — the Saturday, not the UTC Sunday.
  assert.equal(taken.localDate, DST_TODAY);
  assert.equal(taken.occurrenceId, harness.state.occurrenceId, "the occurrence it now has, so the client can open it straight away");
  assert.equal(taken.undoGroupId, "7c6b5a49-3827-4160-9f0e-1d2c3b4a5968");

  assert.equal(harness.calls.applied.length, 1);
  const { actions, scope } = harness.calls.applied[0];
  assert.deepEqual(scope, { workspaceId: WORKSPACE_ID, actorUserId: USER_ID, recipientUserId: USER_ID });
  assert.deepEqual(actions, [
    {
      type: "reschedule",
      intent: "explicit",
      timezone: DST_TIMEZONE,
      // The user's own morning time, as the button reads it from the settings row.
      reviewTime: "07:30",
      target: { kind: "task", taskId: id(1), taskVersion: 4 },
      when: { mode: "date", date: DST_TODAY },
      recurrence: null,
      reason: null,
    },
  ]);
});

test("«делаю сегодня» works on an overdue one-off, and moves its date rather than the task", async (t) => {
  // The pool is not «fuzzy tasks»: `POOL_MEMBERSHIP` also holds a one-off whose day has passed, the
  // week screen draws a take-today button on that row, and the endpoint used to answer it with the
  // not-found meant for a stranger's id. It also cannot be a `kind: "task"` reschedule —
  // `concretise_task` refuses anything but a fuzzy task — so what moves is the live occurrence.
  const harness = await createApp({
    tasks: [poolTask(1, { version: 4, timeMode: "point", dated: true, occurrenceVersion: 9, overdue: true })],
  });
  t.after(() => harness.close());

  const { status, body } = await harness.call("POST", `/week/take-today/${id(1)}`, { body: { expectedVersion: 4 } });
  assert.equal(status, 200);
  const taken = WeekTakeTodayResponseSchema.parse(body);
  assert.equal(taken.taskId, id(1));
  assert.equal(taken.localDate, DST_TODAY);
  assert.equal(taken.undoGroupId, "7c6b5a49-3827-4160-9f0e-1d2c3b4a5968");

  assert.equal(harness.calls.applied.length, 1);
  const { actions } = harness.calls.applied[0];
  assert.deepEqual(actions[0].target, {
    kind: "occurrence",
    taskId: id(1),
    taskVersion: 4,
    occurrenceId: harness.state.occurrenceId,
    // Read on the server: the pool row carries the task's version and no occurrence at all.
    occurrenceVersion: 9,
    timezone: DST_TIMEZONE,
  });
  assert.deepEqual(actions[0].when, { mode: "date", date: DST_TODAY });
});

test("a rule take-today cannot satisfy is a domain refusal, not a not-found", async (t) => {
  // An overdue critical task on its second move needs a reason, and the tap carries none. The
  // client can route that to the reschedule sheet; it could do nothing with a 404.
  const harness = await createApp({
    tasks: [poolTask(1, { version: 4, timeMode: "point", dated: true, importance: "critical" })],
    issues: [{ kind: "domain", code: "reason_required", message: "reschedule reason is required" }],
  });
  t.after(() => harness.close());

  const { status, body } = await harness.call("POST", `/week/take-today/${id(1)}`, { body: { expectedVersion: 4 } });
  assert.equal(status, 422);
  assert.equal(body.error.code, "domain_rule");
  assert.equal(body.error.details.rule, "reason_required");
  assert.equal(harness.calls.applied.length, 0, "a refused action never reaches the journal");
});

test("take-today refuses a row that has moved, and says which version it found", async (t) => {
  const harness = await createApp({ tasks: [poolTask(1, { version: 6 })] });
  t.after(() => harness.close());

  const { status, body } = await harness.call("POST", `/week/take-today/${id(1)}`, { body: { expectedVersion: 5 } });
  assert.equal(status, 409);
  assert.deepEqual(body, { error: { code: "conflict", message: "The object changed since it was read", details: { kind: "conflict", currentVersion: 6 } } });
  assert.equal(harness.calls.applied.length, 0, "a stale version never reaches the journal");
});

test("take-today refuses a task that already has a day, or is no longer active", async (t) => {
  const harness = await createApp({
    tasks: [poolTask(1, { timeMode: "point", pool: false }), poolTask(2, { status: "closed" })],
  });
  t.after(() => harness.close());

  for (const taskId of [id(1), id(2)]) {
    const { status, body } = await harness.call("POST", `/week/take-today/${taskId}`, { body: { expectedVersion: 1 } });
    assert.equal(status, 404);
    assert.deepEqual(body, { error: { code: "not_found", message: "Not found" } });
  }
  assert.equal(harness.calls.applied.length, 0);
});

test("take-today validates its body and its path, and names no value it was sent", async (t) => {
  const harness = await createApp({ tasks: [poolTask(1)] });
  t.after(() => harness.close());

  const noVersion = await harness.call("POST", `/week/take-today/${id(1)}`, { body: {} });
  assert.equal(noVersion.status, 400);
  assert.deepEqual(noVersion.body, {
    error: { code: "validation_failed", message: "Request does not match the contract", details: { kind: "fields", fields: ["expectedVersion"] } },
  });

  const badVersion = await harness.call("POST", `/week/take-today/${id(1)}`, { body: { expectedVersion: "seven", secret: "hunter2" } });
  assert.equal(badVersion.status, 400);
  assert.equal(JSON.stringify(badVersion.body).includes("hunter2"), false, "an error must never echo what it was sent");

  const badId = await harness.call("POST", "/week/take-today/not-a-uuid", { body: { expectedVersion: 1 } });
  assert.equal(badId.status, 400);
  assert.equal(badId.body.error.code, "validation_failed");

  const badPage = await harness.call("GET", "/week?pageSize=9999");
  assert.equal(badPage.status, 400);
  assert.deepEqual(badPage.body.error.details, { kind: "fields", fields: ["pageSize"] });

  assert.equal(harness.calls.applied.length, 0);
});

/* ------------------------------------------------------------------ the guard */

test("every week route is behind the guard", async (t) => {
  const harness = await createApp({ tasks: [poolTask(1)] });
  t.after(() => harness.close());

  const routes = [
    ["GET", "/week", undefined],
    ["POST", `/week/pick/${id(1)}`, undefined],
    ["DELETE", `/week/pick/${id(1)}`, undefined],
    ["POST", `/week/take-today/${id(1)}`, { expectedVersion: 1 }],
  ];
  for (const [method, path, body] of routes) {
    const { status, body: answer } = await harness.call(method, path, { body, authorization: null });
    assert.equal(status, 401, `${method} ${path}`);
    assert.deepEqual(answer, { error: { code: "unauthorized", message: "Authentication required" } });
  }
  assert.equal(harness.calls.plan.length, 0, "an unauthenticated request never reaches a service");
  assert.equal(harness.calls.toggle.length, 0);
  assert.equal(harness.calls.applied.length, 0);
});
