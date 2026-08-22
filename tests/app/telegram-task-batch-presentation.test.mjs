import assert from "node:assert/strict";
import test from "node:test";
import { actionSummary, chatResultKeyboard } from "../../dist/telegram/telegram-chat-reply.service.js";

test("task batch presentation shows step count with one confirmation control", () => {
  assert.equal(actionSummary(4), "Нужно подтвердить: 4.");
  const keyboard = chatResultKeyboard(undefined, "group-id");
  assert.deepEqual(keyboard.inline_keyboard.flat().map((button) => button.text), ["Подтвердить", "Не делать"]);
  assert.equal(JSON.stringify(keyboard).includes("step"), false);
});

test("applied task batch presentation exposes one Undo control", () => {
  const keyboard = chatResultKeyboard("group-id");
  assert.deepEqual(keyboard.inline_keyboard.flat().map((button) => button.text), ["↩️ Отменить"]);
});
