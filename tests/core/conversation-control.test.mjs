import assert from "node:assert/strict";
import test from "node:test";
import { detectConversationControl, isClearConversationRequest } from "../../.core-dist/conversation-control.js";

test("explicit discussion controls are deterministic", () => {
  assert.equal(detectConversationControl("Хватит вопросов"), "conclude");
  assert.equal(detectConversationControl("сделай вывод"), "conclude");
  assert.equal(detectConversationControl("Закончить"), "end");
  assert.equal(detectConversationControl("ничего не сохраняй"), "no_persist");
});

test("ordinary prose does not accidentally become a control", () => {
  assert.equal(detectConversationControl("Я думаю закончить задачу завтра"), null);
  assert.equal(detectConversationControl("Мне не нравится сохранять чеки"), null);
});

test("clear-history requests stay out of AI processing", () => {
  assert.equal(isClearConversationRequest("Очисти историю чата"), true);
  assert.equal(isClearConversationRequest("Очистить AI-историю"), true);
  assert.equal(isClearConversationRequest("Очистити AI-історію"), true);
  assert.equal(isClearConversationRequest("Clear AI history"), true);
  assert.equal(isClearConversationRequest("/clear"), true);
  assert.equal(isClearConversationRequest("Я хочу очистить историю чата позже"), false);
  assert.equal(isClearConversationRequest("Очистить контекст пользователя"), false);
});
