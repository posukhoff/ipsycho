import test from "node:test";
import assert from "node:assert/strict";
import { TelegramService } from "../../dist/telegram/telegram.service.js";

const config = { telegramBotToken: "123456:test-token-with-enough-length-abcdef", botIdentity: "test" };
const botInfo = {
  id: 1,
  is_bot: true,
  first_name: "b",
  username: "b",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

/** The update ledger: the first arrival of an update id is claimed, a redelivery is not. */
function fakeUpdates() {
  const claimed = new Set();
  return {
    handled: [],
    claim: async ({ updateId }) => {
      if (claimed.has(updateId)) return false;
      claimed.add(updateId);
      return true;
    },
    markHandled: async () => undefined,
    markLost: async () => 0,
  };
}
const known = new Set([100, 200]);
const fakeAccess = { resolveActiveUser: async (id) => (known.has(id) ? { user: { id: `u${id}`, aiStatus: "enabled", telegramUserId: id }, workspaceId: `w${id}` } : null) };
const fakeSettings = { get: async (userId) => ({ userId, timezone: "Europe/Kyiv", pinnedLanguage: userId === "u200" ? "en" : null }) };

function service() {
  const instance = new TelegramService(config, fakeUpdates(), fakeAccess, fakeSettings);
  instance.bot.botInfo = botInfo;
  return instance;
}

function messageUpdate(updateId, chatId, text, chatType = "private") {
  const from = { id: chatId, is_bot: false, first_name: "u", language_code: "ru" };
  const command = text.match(/^\/\w+/u);
  const entities = command ? [{ type: "bot_command", offset: 0, length: command[0].length }] : [];
  return { update_id: updateId, message: { message_id: updateId, date: 1, chat: { id: chatId, type: chatType, first_name: "u" }, from, text, entities } };
}

function callbackUpdate(updateId, chatId, data) {
  const from = { id: chatId, is_bot: false, first_name: "u", language_code: "ru" };
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from,
      chat_instance: "x",
      data,
      message: { message_id: 1, date: 1, chat: { id: chatId, type: "private", first_name: "u" }, text: "card" },
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Captures outgoing API calls without a network. */
function captureApi(bot) {
  const calls = [];
  bot.api.config.use(async (prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: method === "sendMessage" ? { message_id: 1, date: 1, chat: { id: 1, type: "private" }, text: "" } : true };
  });
  return calls;
}

test("updates from different chats overlap while one chat stays strictly in order", async () => {
  const telegram = service();
  const events = [];
  telegram.bot.on("message:text", async (ctx) => {
    events.push(`start ${ctx.message.text}`);
    await sleep(ctx.message.text.startsWith("slow") ? 120 : 10);
    events.push(`end ${ctx.message.text}`);
  });

  await Promise.all([
    telegram.bot.handleUpdate(messageUpdate(1, 100, "slow-a1")),
    telegram.bot.handleUpdate(messageUpdate(2, 100, "a2")),
    telegram.bot.handleUpdate(messageUpdate(3, 200, "b1")),
  ]);

  assert.ok(events.indexOf("end slow-a1") < events.indexOf("start a2"), events.join(" | "));
  assert.ok(events.indexOf("start b1") < events.indexOf("end slow-a1"), events.join(" | "));
});

test("access and locale are resolved once per update and handed to the handler", async () => {
  const telegram = service();
  let seen;
  telegram.bot.on("message:text", async (ctx) => {
    seen = ctx.state;
  });
  await telegram.bot.handleUpdate(messageUpdate(4, 200, "hi"));
  assert.equal(seen.access.workspaceId, "w200");
  assert.equal(seen.settings.timezone, "Europe/Kyiv");
  assert.equal(seen.locale, "en", "a pinned language wins over the Telegram language");
});

test("an unknown user gets one consistent refusal on every command, text and button", async () => {
  const telegram = service();
  const calls = captureApi(telegram.bot);
  let handled = 0;
  telegram.bot.command("help", async () => {
    handled += 1;
  });
  telegram.bot.on("message:text", async () => {
    handled += 1;
  });
  telegram.bot.callbackQuery(/.*/, async () => {
    handled += 1;
  });

  await telegram.bot.handleUpdate(messageUpdate(5, 999, "/help"));
  await telegram.bot.handleUpdate(messageUpdate(6, 999, "привет"));
  await telegram.bot.handleUpdate(callbackUpdate(7, 999, "occ:done:00000000-0000-0000-0000-000000000000"));

  assert.equal(handled, 0);
  const replies = calls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text);
  assert.equal(replies.length, 2);
  assert.ok(
    replies.every((text) => /закрытый|приглашение/.test(text)),
    replies.join(" | "),
  );
  assert.equal(calls.filter((call) => call.method === "answerCallbackQuery").length, 1);
});

test("/start with an invitation and /restore reach their handlers without access", async () => {
  const telegram = service();
  const reached = [];
  telegram.bot.command("start", async (ctx) => {
    reached.push(`start:${ctx.state.access === null}`);
  });
  telegram.bot.command("restore", async (ctx) => {
    reached.push(`restore:${ctx.state.access === null}`);
  });
  await telegram.bot.handleUpdate(messageUpdate(8, 999, "/start join_" + "A".repeat(43)));
  await telegram.bot.handleUpdate(messageUpdate(9, 999, "/restore"));
  assert.deepEqual(reached, ["start:true", "restore:true"]);
});

test("a group chat gets one sentence for a command and silence otherwise", async () => {
  const telegram = service();
  const calls = captureApi(telegram.bot);
  let handled = 0;
  telegram.bot.on("message:text", async () => {
    handled += 1;
  });
  await telegram.bot.handleUpdate(messageUpdate(10, -500, "hello", "group"));
  await telegram.bot.handleUpdate(messageUpdate(11, -500, "/start", "group"));
  assert.equal(handled, 0);
  const replies = calls.filter((call) => call.method === "sendMessage");
  assert.equal(replies.length, 1);
  assert.match(replies[0].payload.text, /личных сообщениях/);
});
