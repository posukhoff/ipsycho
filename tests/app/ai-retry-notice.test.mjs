import test from "node:test";
import assert from "node:assert/strict";
import { AiRetryService } from "../../dist/chat/ai-retry.service.js";

/** One row as `findDueAiRetries` returns it, for a message whose automatic attempts are running out. */
function row(aiRetryCount, settings = { timezone: "Europe/Kyiv", pinnedLanguage: "ru", telegramLanguage: null }) {
  return {
    message: {
      id: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      userId: "00000000-0000-4000-8000-000000000003",
      content: "Напомни через четыре часа позвонить в клинику по поводу анализов",
      aiRetryCount,
    },
    user: { telegramUserId: 4242 },
    settings,
  };
}

function harness(aiRetryCount, options = {}) {
  const sent = [];
  const deferred = [];
  const messages = {
    findDueAiRetries: async () => [options.settings ? row(aiRetryCount, options.settings) : row(aiRetryCount)],
    setStatus: async () => undefined,
    deferAiUntil: async (_workspaceId, _userId, messageId, until) => {
      deferred.push({ messageId, until });
    },
  };
  const chat = {
    retryMessage: async () => {
      if (options.retryResult) return options.retryResult;
      throw new Error("provider timed out");
    },
  };
  const telegram = {
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
      return 1;
    },
  };
  return { service: new AiRetryService(messages, chat, telegram), sent, deferred };
}

test("the user is told when the automatic retries are spent, because nothing will pick the message up again", async () => {
  // After the second failure `aiNextRetryAt` is null and `findDueAiRetries` never selects the row,
  // so silence here means the message stays in `waiting_ai` and the answer never arrives.
  const { service, sent } = harness(2);
  await service.runTick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 4242);
  assert.match(sent[0].text, /\/retry_ai/);
  assert.match(sent[0].text, /позвонить в клинику/);
});

test("a failure with an automatic attempt still to come stays quiet", async () => {
  // `nextAutomaticAiRetryAt` still returns a time for the second failure, so the message is not lost
  // yet and saying otherwise would be a lie.
  for (const spent of [0, 1]) {
    const { service, sent } = harness(spent);
    await service.runTick();
    assert.equal(sent.length, 0, `notified while attempt ${spent + 1} of ${2} was still to come`);
  }
});

test("a provider that is not configured gets a new due time instead of being re-read every minute", async () => {
  const { service, sent, deferred } = harness(0, { retryResult: { kind: "ai_unavailable" } });
  await service.runTick();
  assert.equal(sent.length, 0);
  assert.equal(deferred.length, 1);
  assert.ok(deferred[0].until.getTime() > Date.now());
});

test("a user who never pinned a language is written to in the language Telegram reports, not English", () => {
  // Nothing here can read `from.language_code`: there is no update. Before the language was
  // remembered on the settings row every such push went out in English.
  const cases = [
    { telegramLanguage: "uk", expect: /Так і не зміг/u },
    { telegramLanguage: "ru-RU", expect: /Так и не смог/u },
    { telegramLanguage: null, expect: /I still could not/u },
  ];
  return Promise.all(
    cases.map(async ({ telegramLanguage, expect }) => {
      const { service, sent } = harness(2, { settings: { timezone: "Europe/Kyiv", pinnedLanguage: null, telegramLanguage } });
      await service.runTick();
      assert.match(sent[0].text, expect);
    }),
  );
});
