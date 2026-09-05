import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import "reflect-metadata";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { AccessService } from "../../dist/access/access.service.js";
import { AiService } from "../../dist/ai/ai.service.js";
import { InitDataGuard } from "../../dist/api/auth/init-data.guard.js";
import { ApiIpRateLimiter, ApiUserRateLimiter, IP_RATE_LIMIT, USER_RATE_LIMIT } from "../../dist/api/auth/rate-limiter.js";
import { WebAuthModule } from "../../dist/api/auth/web-auth.module.js";
import { MeResponseSchema } from "../../dist/api/contracts/index.js";
import { ApiExceptionFilter } from "../../dist/api/http/api-exception.filter.js";
import { ChatService } from "../../dist/chat/chat.service.js";
import { APP_CONFIG } from "../../dist/config.js";
import { DatabaseService } from "../../dist/database/database.service.js";
import { JobQueueService } from "../../dist/queue/job-queue.service.js";
import { SettingsService } from "../../dist/settings/settings.service.js";
import { TelegramService } from "../../dist/telegram/telegram.service.js";

/**
 * The Mini App's front door, exercised over a real socket.
 *
 * Everything below the guard is a fake, because none of it is what this file is about: the subject
 * is the order of the checks (IP limiter → HMAC → allowlist → per-user limiter), the fact that all
 * refusals are one indistinguishable answer, and the fact that nothing the caller sent is ever
 * logged. The signature itself is covered in `tests/core/init-data.test.mjs`.
 */

const BOT_TOKEN = "123456:AA-test-bot-token-not-a-real-one";
const OWNER_TELEGRAM_ID = 4242;

/** A first name and a start param no other string in this process contains, so a leak is findable. */
const CANARY_NAME = "Zoltan-Canary-Qx7";

const CONFIG = {
  nodeEnv: "test",
  appCommit: "abc1234",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgres://unused/unused",
  telegramBotToken: BOT_TOKEN,
  botIdentity: "webapp-auth-test",
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

const USER_ID = "1f2e3d4c-5b6a-4798-8899-aabbccddeeff";
const WORKSPACE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const ACTIVE_ACCESS = {
  user: { id: USER_ID, telegramUserId: OWNER_TELEGRAM_ID, status: "active", aiStatus: "enabled" },
  workspaceId: WORKSPACE_ID,
};

const SETTINGS_ROW = {
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
  eventReminderOffsetsMinutes: [-60, -15, "not a number"],
  plannedTaskReminderOffsetMinutes: 0,
  criticalPostDueMinutes: 60,
  seenNormalMinutes: 60,
  seenRequiredMinutes: 30,
  seenCriticalMinutes: 15,
  version: 7,
};

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

function initData({ telegramUserId = OWNER_TELEGRAM_ID, ageMs = 60_000, extra = {} } = {}) {
  const fields = {
    user: JSON.stringify({ id: telegramUserId, first_name: CANARY_NAME, username: "canary", language_code: "uk" }),
    chat_instance: "-1234567890123456789",
    chat_type: "sender",
    auth_date: String(Math.floor((Date.now() - ageMs) / 1000)),
    ...extra,
  };
  return encode({ ...fields, hash: sign(fields) });
}

/** Percent-encoded by hand: `URLSearchParams` is not in the lint globals for test files. */
function encode(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

/* ------------------------------------------------------------------ harness */

async function createApp(options = {}) {
  const calls = { resolveActiveUser: 0, settingsGet: 0, historyMessageCount: 0 };
  const state = {
    activeFor: options.activeFor ?? OWNER_TELEGRAM_ID,
    settings: "settings" in options ? options.settings : SETTINGS_ROW,
    callsLastHour: options.callsLastHour ?? 0,
    historyFails: options.historyFails ?? false,
  };

  const moduleRef = await Test.createTestingModule({
    imports: [WebAuthModule],
    // `ApiModule` registers the filter; this file mounts one module of it, so it registers its own.
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
      resolveActiveUser: async (telegramUserId) => {
        calls.resolveActiveUser += 1;
        return telegramUserId === state.activeFor ? ACTIVE_ACCESS : null;
      },
      findRestorable: async () => null,
    })
    .overrideProvider(AiService)
    .useValue({
      providerName: "openai",
      consentVersion: CONFIG.aiConsentVersion,
      maxCallsPerHour: CONFIG.aiMaxCallsPerHour,
      isConfigured: () => true,
      hasConsent: async () => true,
      hasProviderConsent: async () => false,
      callsLastHour: async () => state.callsLastHour,
      onApplicationBootstrap: () => undefined,
    })
    .overrideProvider(ChatService)
    .useValue({
      providerName: "openai",
      isAiConfigured: () => true,
      historyMessageCount: async () => {
        calls.historyMessageCount += 1;
        if (state.historyFails) throw new Error("connection terminated unexpectedly");
        return 12;
      },
    })
    .compile();

  // The real instance, with one method replaced: the repository underneath it is what must not run.
  const settings = moduleRef.get(SettingsService, { strict: false });
  settings.get = async () => {
    calls.settingsGet += 1;
    return state.settings;
  };

  const app = moduleRef.createNestApplication();
  // The one hop `main.ts` trusts, so `req.ip` is the client rather than Caddy's container address.
  app.set("trust proxy", 1);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address();

  app.get(ApiIpRateLimiter).reset();
  app.get(ApiUserRateLimiter).reset();

  return {
    app,
    calls,
    state,
    ipLimiter: app.get(ApiIpRateLimiter),
    userLimiter: app.get(ApiUserRateLimiter),
    async me({ raw, ip = "203.0.113.7", authorization } = {}) {
      const headers = { "X-Forwarded-For": ip };
      const value = authorization ?? (raw === undefined ? `tma ${initData()}` : raw === null ? null : `tma ${raw}`);
      if (value !== null) headers.Authorization = value;
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/me`, { headers });
      return { status: response.status, body: await response.json() };
    },
    close: () => app.close(),
  };
}

const UNAUTHORIZED = { error: { code: "unauthorized", message: "Authentication required" } };

/* ------------------------------------------------------------------ tests */

test("GET /me answers the bootstrap call and says nothing about Telegram", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const { status, body } = await harness.me();
  assert.equal(status, 200);
  const parsed = MeResponseSchema.parse(body);

  assert.deepEqual(parsed.access, { userId: USER_ID, workspaceId: WORKSPACE_ID, status: "active", isOwner: true });
  // No pinned language, so the language Telegram sent in this payload wins — the bot's own rule.
  assert.equal(parsed.locale, "uk");
  assert.equal(parsed.timezone, "Europe/Kyiv");
  assert.match(parsed.todayLocalDate, /^\d{4}-\d{2}-\d{2}$/u);
  assert.deepEqual(parsed.ai, { status: "enabled", configured: true, provider: "openai", rateLimited: false });
  assert.deepEqual(parsed.consents, [
    { scope: "text", granted: true, provider: "openai", version: "2" },
    { scope: "voice", granted: false, provider: "openai", version: "2" },
  ]);
  assert.equal(parsed.commit, "abc1234");

  assert.equal(parsed.settings.version, 7);
  assert.equal(parsed.settings.resolvedLocale, "ru", "the settings screen resolves from the stored row, not from this payload");
  assert.deepEqual(parsed.settings.morningDigest, { enabled: true, time: "09:00" });
  assert.deepEqual(parsed.settings.quietHours, { enabled: true, weekdayStart: "22:00", weekdayEnd: "08:00", weekendStart: "23:00", weekendEnd: "09:00", timezone: "Europe/Kyiv" });
  // The jsonb column can hold anything; the presenter narrows it instead of trusting the row.
  assert.deepEqual(parsed.settings.reminderDefaults.eventOffsetsMinutes, [-60, -15]);
  assert.deepEqual(parsed.settings.escalationMinutes, { normal: 60, required: 30, critical: 15 });
  assert.equal(parsed.settings.onboardingCompletedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(parsed.settings.historyMessageCount, 12);

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(CANARY_NAME), "the Telegram user object must not reach the response");
  assert.ok(!serialized.includes(String(OWNER_TELEGRAM_ID)), "the Telegram id is traded for the internal uuid and never echoed");
});

test("unknown, disabled and deletion-pending users get one refusal, and so does every forgery", async (t) => {
  const harness = await createApp({ activeFor: OWNER_TELEGRAM_ID });
  t.after(() => harness.close());

  const valid = initData();
  const forged = `${valid.slice(0, -1)}${valid.endsWith("a") ? "b" : "a"}`;
  const expired = initData({ ageMs: 25 * 60 * 60 * 1000 });
  const withoutUser = (() => {
    const fields = { auth_date: String(Math.floor(Date.now() / 1000)), chat_type: "sender" };
    return encode({ ...fields, hash: sign(fields) });
  })();

  const cases = {
    "no header": await harness.me({ raw: null, ip: "203.0.113.10" }),
    // `AccessService.resolveActiveUser` returns null for unknown, disabled *and* deletion-pending
    // alike, which is why the three cannot be told apart from outside.
    "not on the allowlist": await harness.me({ raw: initData({ telegramUserId: 99 }), ip: "203.0.113.11" }),
    "wrong scheme": await harness.me({ authorization: `Bearer ${valid}`, ip: "203.0.113.12" }),
    "empty credential": await harness.me({ authorization: "tma ", ip: "203.0.113.13" }),
    "forged hash": await harness.me({ raw: forged, ip: "203.0.113.14" }),
    "short hash": await harness.me({ raw: `${valid.slice(0, valid.length - 1)}`, ip: "203.0.113.15" }),
    "day-old payload": await harness.me({ raw: expired, ip: "203.0.113.16" }),
    "no user in the payload": await harness.me({ raw: withoutUser, ip: "203.0.113.17" }),
    "not initData at all": await harness.me({ raw: "hello", ip: "203.0.113.18" }),
  };

  for (const [name, result] of Object.entries(cases)) {
    assert.equal(result.status, 401, name);
    assert.deepEqual(result.body, UNAUTHORIZED, `${name} must be byte-identical to every other refusal`);
  }
});

test("unsigned input never reaches PostgreSQL", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const valid = initData();
  for (const raw of [null, "hello", `${valid.slice(0, -1)}0`, initData({ ageMs: 25 * 60 * 60 * 1000 })]) {
    await harness.me({ raw, ip: "203.0.113.20" });
  }
  assert.equal(harness.calls.resolveActiveUser, 0, "the allowlist lookup runs only behind the HMAC");
  assert.equal(harness.calls.settingsGet, 0);

  await harness.me({ ip: "203.0.113.20" });
  assert.equal(harness.calls.resolveActiveUser, 1);
  assert.equal(harness.calls.settingsGet, 1);
});

test("the IP limiter runs before the HMAC, so a flood costs one hash and no query", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const ip = "198.51.100.4";
  let refused = null;
  for (let attempt = 0; attempt <= IP_RATE_LIMIT.limit; attempt += 1) {
    const result = await harness.me({ raw: "not-signed", ip });
    if (result.status === 429) {
      refused = result;
      break;
    }
  }

  assert.ok(refused, `the IP limiter must refuse within ${IP_RATE_LIMIT.limit + 1} unsigned requests`);
  assert.equal(refused.body.error.code, "rate_limited");
  assert.equal(refused.body.error.details.kind, "retry");
  assert.ok(refused.body.error.details.retryAfterSeconds > 0 && refused.body.error.details.retryAfterSeconds <= 60);
  assert.equal(harness.calls.resolveActiveUser, 0);

  // Another address is unaffected: the bucket is per client, which is the whole point of trusting
  // exactly one proxy hop. Keyed on Caddy's address instead, one stranger would lock out everyone.
  const other = await harness.me({ ip: "198.51.100.5" });
  assert.equal(other.status, 200);
});

test("the per-user limiter runs after the allowlist, keyed on the internal uuid", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  // Spend the user's budget directly: driving it over HTTP would hit the IP limiter first, which is
  // exactly the ordering this test relies on.
  for (let hit = 0; hit < USER_RATE_LIMIT.limit; hit += 1) harness.userLimiter.consume(USER_ID);

  const refused = await harness.me({ ip: "198.51.100.9" });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, "rate_limited");
  assert.equal(harness.calls.resolveActiveUser, 1, "the identity is resolved before its bucket is checked");
  assert.equal(harness.calls.historyMessageCount, 0, "and the handler never runs");

  harness.userLimiter.reset();
  assert.equal((await harness.me({ ip: "198.51.100.10" })).status, 200);
});

test("nothing the caller sent is written to the log, refused or failed", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  const raw = initData({ extra: { start_param: "task_secret_hint" } });
  const captured = await capturingOutput(async () => {
    // A refused request: a forged payload that still carries a real hash, auth_date and first name.
    await harness.me({ raw: `${raw.slice(0, -1)}0`, ip: "192.0.2.31" });
    // A refusal that happens after the identity is known, so a line with a userId on it exists.
    for (let hit = 0; hit < USER_RATE_LIMIT.limit; hit += 1) harness.userLimiter.consume(USER_ID);
    await harness.me({ raw, ip: "192.0.2.32" });
    harness.userLimiter.reset();
    // And an authenticated request whose handler then fails, which is the path through `safeError`.
    harness.state.historyFails = true;
    const failed = await harness.me({ raw, ip: "192.0.2.33" });
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { error: { code: "internal", message: "Internal error" } });
  });

  // The three keys tasks.md names, plus the payload itself. `safeError` keeps 300 characters of a
  // message and knows nothing about any of them, so one interpolated `initData` would travel whole.
  for (const needle of ["hash=", "auth_date=", "first_name", CANARY_NAME, "task_secret_hint", raw]) {
    assert.ok(!captured.text.includes(needle), `the log leaked ${JSON.stringify(needle)}`);
  }
  assert.ok(!captured.logText.includes(String(OWNER_TELEGRAM_ID)), "the Telegram id must never be logged; the internal uuid is");

  // All three requests were logged, and the fields are a closed set: this is what stops a later
  // "just add the payload while we debug this" from surviving review.
  const guardLines = captured.lines.filter((line) => line.event === "web request refused");
  assert.equal(guardLines.length, 2, `expected two guard refusals, saw ${captured.logText}`);
  const allowed = new Set(["ts", "level", "event", "requestId", "userId", "reason", "path", "code", "status", "error"]);
  for (const line of captured.lines) {
    for (const key of Object.keys(line)) assert.ok(allowed.has(key), `unexpected log field ${key} in ${JSON.stringify(line)}`);
  }
  for (const line of guardLines) assert.match(line.requestId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(
    guardLines.map((line) => line.reason),
    ["signature_mismatch", "rate_limited_user"],
  );
  // Identity, when there is one, is the internal uuid — the Telegram id was already traded away.
  assert.equal(guardLines[0].userId, undefined, "a forgery has no identity to log");
  assert.equal(guardLines[1].userId, USER_ID);

  const failure = captured.lines.find((line) => line.event === "api request failed");
  assert.ok(failure, "the failed authenticated request is logged");
  assert.deepEqual(failure.error, { name: "Error", message: "connection terminated unexpectedly" });
});

test("an active user with no settings row is a 503, not a refusal that looks like the allowlist", async (t) => {
  const harness = await createApp({ settings: null });
  t.after(() => harness.close());

  const { status, body } = await harness.me({ ip: "192.0.2.40" });
  assert.equal(status, 503);
  assert.equal(body.error.code, "unavailable");
  assert.equal(harness.calls.resolveActiveUser, 1);
});

test("the module exports the guard and the limiters the other API groups depend on", async (t) => {
  const harness = await createApp();
  t.after(() => harness.close());

  // Groups 2–4 write `imports: [WebAuthModule]` and `@UseGuards(InitDataGuard)`. That resolves the
  // guard from their own injector, so the module has to export it — and both limiters have to be
  // one instance per process, or a flood is permitted once per module.
  assert.ok(harness.app.get(InitDataGuard) instanceof InitDataGuard);
  assert.equal(harness.app.get(ApiIpRateLimiter), harness.ipLimiter);
  assert.equal(harness.app.get(ApiUserRateLimiter), harness.userLimiter);
});

test("the AI budget is reported rather than hidden", async (t) => {
  const harness = await createApp({ callsLastHour: CONFIG.aiMaxCallsPerHour });
  t.after(() => harness.close());

  const { body } = await harness.me({ ip: "192.0.2.50" });
  assert.equal(body.ai.rateLimited, true);
});

/* ------------------------------------------------------------------ helpers */

/**
 * A Drizzle-shaped object where every chain is legal and every await yields no rows.
 *
 * `WebAuthModule` reaches `ChatService` (for the AI history count `GET /me` reports), and through it
 * the bootstrap hooks of the reminder and briefing loops. None of them is the subject here, and
 * stubbing each service by name would make this file break every time one is added.
 */
function inertDb() {
  const chain = () =>
    new Proxy(function () {}, {
      get: (_target, property) => (property === "then" ? (resolve) => resolve([]) : chain()),
      apply: () => chain(),
    });
  return chain();
}

/** The logger writes JSON lines straight to the streams, so this is the only way to read them. */
async function capturingOutput(work) {
  const chunks = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  // Everything is passed through as well as recorded: the test runner's own reporter writes to
  // these streams, and swallowing it would silently drop the results of whatever else is running.
  const capture = (through) => (chunk, encoding, callback) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return through(chunk, encoding, callback);
  };
  process.stdout.write = capture(stdout);
  process.stderr.write = capture(stderr);
  try {
    await work();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  // The test runner writes its own binary protocol to the same stream, so the log lines are picked
  // out by their shape rather than by splitting the stream.
  const text = chunks.join("");
  const lines = [];
  for (const match of text.matchAll(/\{"ts":"[^\n]*/gu)) {
    try {
      lines.push(JSON.parse(match[0]));
    } catch {
      lines.push({ unparsed: match[0] });
    }
  }
  return { text, logText: lines.map((line) => JSON.stringify(line)).join("\n"), lines };
}
