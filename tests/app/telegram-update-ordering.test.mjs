import test from "node:test";
import assert from "node:assert/strict";
import { TelegramService } from "../../dist/telegram/telegram.service.js";

const config = { telegramBotToken: "123456:test-token-with-enough-length-abcdef", botIdentity: "test" };

function fakeDatabase() {
  return { db: { insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ updateId: 1 }] }) }) }) } };
}

function messageUpdate(updateId, chatId, text) {
  const from = { id: chatId, is_bot: false, first_name: "u" };
  return { update_id: updateId, message: { message_id: updateId, date: 1, chat: { id: chatId, type: "private", first_name: "u" }, from, text } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("updates from different chats overlap while one chat stays strictly in order", async () => {
  const service = new TelegramService(config, fakeDatabase());
  service.bot.botInfo = { id: 1, is_bot: true, first_name: "b", username: "b", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
  const events = [];
  service.bot.on("message:text", async (ctx) => {
    events.push(`start ${ctx.message.text}`);
    await sleep(ctx.message.text.startsWith("slow") ? 120 : 10);
    events.push(`end ${ctx.message.text}`);
  });

  await Promise.all([
    service.bot.handleUpdate(messageUpdate(1, 100, "slow-a1")),
    service.bot.handleUpdate(messageUpdate(2, 100, "a2")),
    service.bot.handleUpdate(messageUpdate(3, 200, "b1")),
  ]);

  // Chat 100: a2 must not start before a1 ends.
  assert.ok(events.indexOf("end slow-a1") < events.indexOf("start a2"), events.join(" | "));
  // Chat 200: b1 runs while a1 is still in flight.
  assert.ok(events.indexOf("start b1") < events.indexOf("end slow-a1"), events.join(" | "));
});

test("non-private chats are dropped before any handler runs", async () => {
  const service = new TelegramService(config, fakeDatabase());
  service.bot.botInfo = { id: 1, is_bot: true, first_name: "b", username: "b", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
  let handled = 0;
  service.bot.on("message:text", async () => { handled += 1; });
  const update = messageUpdate(9, -500, "hello");
  update.message.chat = { id: -500, type: "group", title: "g" };
  await service.bot.handleUpdate(update);
  assert.equal(handled, 0);
});
