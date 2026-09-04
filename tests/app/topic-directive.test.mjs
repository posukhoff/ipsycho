import test from "node:test";
import assert from "node:assert/strict";
import { ContextService } from "../../dist/context/context.service.js";

const now = new Date("2026-09-04T11:05:00Z");

/** In-memory stand-in for ContextRepository: topics per user plus the message → topic link. */
function fakeRepository(initialTopics = []) {
  let counter = 0;
  const topics = initialTopics.map((topic) => ({ status: "active", clarificationCount: 0, mode: "normal", ...topic }));
  const messageTopics = new Map();
  const pauseAll = (exceptId) => {
    let count = 0;
    for (const topic of topics) if (topic.status === "active" && topic.id !== exceptId) { topic.status = "paused"; count += 1; }
    return count;
  };
  const repository = {
    topics,
    messageTopics,
    findActiveTopic: async () => topics.find((topic) => topic.status === "active") ?? null,
    pauseActiveTopics: async () => pauseAll(),
    setMessageTopic: async (_workspaceId, messageId, topicId) => { messageTopics.set(messageId, topicId); },
    createTopic: async (input) => {
      pauseAll();
      counter += 1;
      const topic = { id: `topic-${counter}`, title: input.title, summary: input.summary, mode: input.mode, status: "active", clarificationCount: 0, lastMessageAt: input.now };
      topics.push(topic);
      return topic;
    },
    updateTopic: async (input) => {
      const topic = topics.find((item) => item.id === input.topicId);
      if (!topic) return null;
      if (input.status === "active") pauseAll(topic.id);
      Object.assign(topic, { summary: input.summary, ...(input.title ? { title: input.title } : {}), ...(input.status ? { status: input.status } : {}), lastMessageAt: input.now });
      return topic;
    },
  };
  return repository;
}

const apply = (repository, directive) => new ContextService(repository).applyTopicDirective({
  workspaceId: "workspace", userId: "user", messageId: "message-1", directive, now,
});

test("none pauses the active topic and detaches the message", async () => {
  const repository = fakeRepository([{ id: "active-1", title: "Отпуск", summary: "куда ехать" }]);
  const topicId = await apply(repository, { mode: "none", title: "мусор", summary: "мусор" });
  assert.equal(topicId, null);
  assert.equal(repository.topics[0].status, "paused");
  assert.equal(repository.topics[0].summary, "куда ехать");
  assert.deepEqual([...repository.messageTopics], [["message-1", null]]);
});

test("new opens a topic, pauses the previous one and links the message", async () => {
  const repository = fakeRepository([{ id: "active-1", title: "Отпуск", summary: "куда ехать" }]);
  const topicId = await apply(repository, { mode: "new", title: "  Ремонт  ", summary: null });
  assert.equal(topicId, "topic-1");
  assert.deepEqual(repository.topics.map((topic) => [topic.id, topic.status]), [["active-1", "paused"], ["topic-1", "active"]]);
  assert.deepEqual(repository.topics[1], { id: "topic-1", title: "Ремонт", summary: "Ремонт", mode: "normal", status: "active", clarificationCount: 0, lastMessageAt: now });
  assert.equal(repository.messageTopics.get("message-1"), "topic-1");
});

test("continue updates the active topic's summary and optional title in place", async () => {
  const repository = fakeRepository([
    { id: "old", title: "Старое", summary: "…", status: "paused" },
    { id: "active-1", title: "Отпуск", summary: "куда ехать" },
  ]);
  const topicId = await apply(repository, { mode: "continue", title: "Отпуск в Грузии", summary: "выбрали Грузию, ищем даты" });
  assert.equal(topicId, "active-1");
  assert.deepEqual(repository.topics[1], { id: "active-1", title: "Отпуск в Грузии", summary: "выбрали Грузию, ищем даты", mode: "normal", status: "active", clarificationCount: 0, lastMessageAt: now });
  assert.equal(repository.topics[0].status, "paused");
  assert.equal(repository.messageTopics.get("message-1"), "active-1");

  // A continue without a summary keeps what was stored instead of blanking it.
  await apply(repository, { mode: "continue", title: null, summary: "   " });
  assert.equal(repository.topics[1].summary, "выбрали Грузию, ищем даты");
});

test("continue without an active topic opens one when titled and is a no-op otherwise", async () => {
  const titled = fakeRepository([{ id: "paused-1", title: "Старое", summary: "…", status: "paused" }]);
  assert.equal(await apply(titled, { mode: "continue", title: "Звонок клиенту", summary: "перенести на вторник" }), "topic-1");
  assert.deepEqual(titled.topics.map((topic) => [topic.id, topic.status]), [["paused-1", "paused"], ["topic-1", "active"]]);
  assert.equal(titled.topics[1].summary, "перенести на вторник");

  const untitled = fakeRepository([{ id: "paused-1", title: "Старое", summary: "…", status: "paused" }]);
  assert.equal(await apply(untitled, { mode: "continue", title: null, summary: "что-то" }), null);
  assert.deepEqual(untitled.topics.map((topic) => topic.status), ["paused"]);
  assert.deepEqual([...untitled.messageTopics], [["message-1", null]]);
});

test("resolve closes the active topic with its final summary and ignores a renamed title", async () => {
  const repository = fakeRepository([{ id: "active-1", title: "Отпуск", summary: "куда ехать" }]);
  const topicId = await apply(repository, { mode: "resolve", title: "Другое имя", summary: "едем в Грузию 12.09" });
  assert.equal(topicId, "active-1");
  assert.deepEqual(repository.topics[0], { id: "active-1", title: "Отпуск", summary: "едем в Грузию 12.09", mode: "normal", status: "resolved", clarificationCount: 0, lastMessageAt: now });
  assert.equal(repository.messageTopics.get("message-1"), "active-1");

  // Resolving with nothing active degrades to none instead of throwing.
  assert.equal(await apply(repository, { mode: "resolve", title: null, summary: "ещё раз" }), null);
});
