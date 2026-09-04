import test from "node:test";
import assert from "node:assert/strict";
import { MAX_REPLY_LENGTH, renderChatResult } from "../../dist/telegram/telegram-chat-render.js";

const base = { kind: "ok", appliedCount: 0, pendingCount: 0, warnings: [] };

test("an over-long model reply is capped for Telegram while the report survives", () => {
  const rendered = renderChatResult({ ...base, text: "а".repeat(5000), report: "✅ Создана задача «Зарядка»" });
  assert.ok(rendered.responseText.length <= MAX_REPLY_LENGTH);
  assert.match(rendered.responseText, /Создана задача «Зарядка»/);
  assert.equal(rendered.keyboard, undefined);
});

test("a pending card renders the confirmation buttons on both delivery paths", () => {
  const rendered = renderChatResult({
    ...base,
    text: "Отменю созвон.",
    pendingCount: 1,
    pendingTitles: ["Отменить «Созвон»"],
    pendingGroupId: "11111111-1111-1111-1111-111111111111",
  });
  assert.match(rendered.persistedText, /Пока ничего не изменил/);
  const buttons = rendered.keyboard.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(buttons, ["act:confirm:11111111-1111-1111-1111-111111111111", "act:cancel:11111111-1111-1111-1111-111111111111"]);
});
