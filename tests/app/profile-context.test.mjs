import test from "node:test";
import assert from "node:assert/strict";
import { ContextService } from "../../dist/context/context.service.js";
import { ChatService } from "../../dist/chat/chat.service.js";

const profileFact = {
  id: "00000000-0000-4000-8000-000000000001",
  version: 3,
  content: "Обычно ложится около 23:30.",
  sensitive: false,
};

const sensitiveProfileFact = {
  id: "00000000-0000-4000-8000-000000000099",
  version: 1,
  content: "Секретный личный факт.",
  sensitive: true,
};

test("the durable user profile is supplied to AI context on every turn", async () => {
  const repository = {
    listTopics: async () => [],
    searchMemory: async () => [profileFact, sensitiveProfileFact],
    listProfile: async () => [profileFact, sensitiveProfileFact],
    profileInvitationState: async () => null,
    listGoalsWithTasks: async () => [],
    listOpenOccurrences: async () => [],
    listTaskGoalLinks: async () => [],
    listAvoidanceEvents: async () => [],
    listRecentBlockers: async () => [],
  };
  const context = new ContextService(repository);
  const result = await context.buildAiContext({ workspaceId: "workspace", userId: "user", query: "создай задачу" });
  assert.deepEqual(result.userProfile, [{
    memoryId: profileFact.id,
    memoryVersion: profileFact.version,
    content: profileFact.content,
    sensitive: false,
  }]);
  assert.deepEqual(result.memory, [{
    memoryId: profileFact.id,
    memoryVersion: profileFact.version,
    type: undefined,
    content: profileFact.content,
    sensitive: false,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /Секретный личный факт/);
  assert.equal(result.profileOnboarding.canOffer, true);
});

test("opening the profile creates an editing topic and shows existing facts", async () => {
  const context = {
    beginProfile: async () => ({ id: "00000000-0000-4000-8000-000000000002" }),
    profileOverview: async () => [profileFact],
  };
  const chat = new ChatService({}, {}, {}, {}, context, {});
  const result = await chat.startProfile({ workspaceId: "workspace", userId: "user" });
  assert.equal(result.kind, "ok");
  assert.equal(result.topicId, "00000000-0000-4000-8000-000000000002");
  assert.match(result.text, /Обычно ложится около 23:30/);
});
