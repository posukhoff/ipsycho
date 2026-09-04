import test from "node:test";
import assert from "node:assert/strict";
import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../dist/app.module.js";
import { ActionsModule } from "../../dist/actions/actions.module.js";
import { SettingsModule } from "../../dist/settings/settings.module.js";
import { APP_CONFIG } from "../../dist/config.js";
import { DatabaseService } from "../../dist/database/database.service.js";
import { TelegramService } from "../../dist/telegram/telegram.service.js";
import { JobQueueService } from "../../dist/queue/job-queue.service.js";
import { SingleInstanceService } from "../../dist/runtime/single-instance.service.js";

test("ActionsModule imports the module that provides SettingsService", () => {
  const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, ActionsModule) ?? [];
  assert.ok(imports.includes(SettingsModule));
});

const config = {
  databaseUrl: "postgres://unused/unused",
  telegramBotToken: "0000000000:AA-not-a-real-token",
  botIdentity: "wiring-test",
  aiProvider: "openai",
  aiModel: "gpt-test",
  openaiApiKey: "sk-test",
  aiConsentVersion: "1",
  aiMaxCallsPerHour: 10,
  aiMaxMessagesPerHour: 10,
  aiTemperature: undefined,
  aiMaxOutputTokens: 1000,
  port: 0,
  host: "127.0.0.1",
};

/**
 * The whole graph, resolved for real. Every provider a service asks for must be exported by a
 * module it imports; a missing edge fails here instead of at the first production boot. Nothing
 * touches PostgreSQL or Telegram: the shutdown order is asserted on fakes.
 */
test("the application graph resolves and shuts down Telegram before the queue and the pool", async () => {
  const order = [];
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(DatabaseService)
    .useValue({ db: {}, pool: { query: async () => ({ rows: [], rowCount: 0 }), on: () => undefined }, onApplicationShutdown: () => void order.push("database") })
    .overrideProvider(TelegramService)
    .useValue({
      bot: { api: {} },
      sendMessage: async () => 1,
      sendReminder: async () => 1,
      sendBriefing: async () => 1,
      onApplicationBootstrap: () => undefined,
      onApplicationShutdown: () => void order.push("telegram"),
    })
    .overrideProvider(JobQueueService)
    .useValue({
      ensureQueue: async () => undefined,
      send: async () => null,
      work: async () => undefined,
      deadLetterCount: async () => 0,
      onApplicationShutdown: () => void order.push("queue"),
    })
    .overrideProvider(SingleInstanceService)
    .useValue({ onApplicationBootstrap: () => undefined, onApplicationShutdown: () => undefined })
    .compile();

  // compile() resolves every dependency; init() is skipped so no loop starts.
  assert.ok(moduleRef.get(APP_CONFIG));
  moduleRef.enableShutdownHooks?.();
  await moduleRef.close();
  assert.deepEqual(
    order.filter((item) => item !== "queue"),
    ["telegram", "database"],
    `unexpected shutdown order: ${order.join(" → ")}`,
  );
});
