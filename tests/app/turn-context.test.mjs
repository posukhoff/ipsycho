import test from "node:test";
import assert from "node:assert/strict";
import { TurnContextService } from "../../dist/chat/turn-context.service.js";

// Friday 2026-09-04 14:05 in Kyiv.
const now = new Date("2026-09-04T11:05:00Z");
const timezone = "Europe/Kyiv";

const profileFact = { id: "00000000-0000-4000-8000-000000000001", version: 3, type: "context", content: "Обычно ложится около 23:30.", sensitive: false };
const sensitiveProfileFact = { id: "00000000-0000-4000-8000-000000000099", version: 1, type: "context", content: "Секретный личный факт.", sensitive: true };
const taskRow = {
  id: "00000000-0000-4000-8000-00000000000a", version: 4, title: "Позвонить врачу", kind: "task", importance: "normal", status: "active", timeMode: "point", timezone,
  plannedStartAt: null, plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null, fuzzyHorizonText: null, reviewAt: null,
  recurrenceRule: null, recurrenceEndLocalDate: null, habitMode: false, habitOfferSentAt: null,
};
const occurrenceRow = {
  id: "00000000-0000-4000-8000-00000000000b", taskId: taskRow.id, status: "scheduled", timezone,
  plannedStartAt: new Date("2026-09-04T15:00:00Z"), plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null, overdue: false,
};
const settingsRow = {
  timezone, pinnedLanguage: "ru", morningDigestEnabled: false, morningReferenceTime: "09:00", eveningDigestEnabled: false, eveningReferenceTime: "20:00",
  weeklyReviewEnabled: false, weeklyReviewWeekday: 7, weeklyReviewTime: "20:00", quietHoursEnabled: false,
  weekdayQuietStart: "22:00", weekdayQuietEnd: "08:00", weekendQuietStart: "23:00", weekendQuietEnd: "09:00", notificationsSnoozedUntil: null,
  eventReminderOffsetsMinutes: [-60, -15], plannedTaskReminderOffsetMinutes: 0, criticalPostDueMinutes: 60, seenNormalMinutes: 60, seenRequiredMinutes: 30, seenCriticalMinutes: 15,
  version: 9,
};

function makeService(overrides = {}) {
  const calls = { briefings: [] };
  const tasks = {
    listTasksForContext: async () => ({
      tasks: [taskRow],
      occurrencesByTask: new Map([[taskRow.id, [occurrenceRow]]]),
      ftsMatchIds: new Set(),
    }),
    listChecklistsForContext: async () => new Map(),
  };
  const context = {
    listGoalsForContext: async () => [],
    listProfile: async () => [profileFact, sensitiveProfileFact],
    searchMemory: async () => [profileFact, sensitiveProfileFact],
    listTopics: async () => overrides.topics ?? [],
    listTaskGoalLinks: async () => [],
    listAvoidanceEvents: async () => [],
    listRecentBlockers: async () => [],
  };
  const settings = { get: async () => settingsRow };
  const briefings = { build: async (input) => { calls.briefings.push(input); return { text: "СНИМОК НЕДЕЛИ" }; } };
  return { service: new TurnContextService(tasks, context, settings, briefings), calls };
}

test("profile facts reach the model under short memory ids and sensitive facts are never serialized", async () => {
  const { service, calls } = makeService();
  const result = await service.build({ workspaceId: "workspace", userId: "user", timezone, query: "создай задачу", now });

  assert.deepEqual(result.model.memory, [{ id: "m1", type: "context", content: profileFact.content }]);
  assert.deepEqual(result.refs.memory.get("m1"), { id: profileFact.id, version: 3, title: profileFact.content });
  assert.doesNotMatch(JSON.stringify(result.model), /Секретный личный факт/);
  assert.doesNotMatch(JSON.stringify(result.model), new RegExp(profileFact.id));

  assert.deepEqual(result.model.tasks, [{ id: "t1", title: "Позвонить врачу", when: "сегодня 18:00" }]);
  assert.deepEqual(result.refs.tasks.get("t1"), { id: taskRow.id, version: 4, title: "Позвонить врачу", timeMode: "point", recurring: false, status: "active" });
  assert.equal(result.model.settings.language, "ru");
  assert.equal("version" in result.model.settings, false);
  assert.equal(result.activeTopic, null);
  assert.equal(result.modelMode, "default");
  assert.deepEqual(result.meta, { tasksShown: 1, tasksTotal: 1, truncated: false });
  assert.equal(result.model.review, undefined);
  assert.equal(calls.briefings.length, 0);
});

test("an analysis topic or a weekly review switches the model mode to deep and adds the review frame", async () => {
  const analysis = makeService({ topics: [{
    id: "topic-1", title: "Стратегия", summary: "думаем о годе", status: "active", mode: "analysis", reviewKind: null, clarificationCount: 2, reviewState: null, lastMessageAt: now,
  }] });
  const deep = await analysis.service.build({ workspaceId: "workspace", userId: "user", timezone, query: "что дальше", now });
  assert.equal(deep.modelMode, "deep");
  assert.deepEqual(deep.activeTopic, { topicId: "topic-1", reviewKind: null, clarificationCount: 2, reviewState: null, mode: "analysis" });
  assert.deepEqual(deep.model.topic.active, { title: "Стратегия", summary: "думаем о годе" });

  const weekly = makeService({ topics: [{
    id: "topic-2", title: "Планирование недели", summary: "…", status: "active", mode: "normal", reviewKind: "weekly", clarificationCount: 1,
    reviewState: { version: 1, outcome: { status: "provided", summary: "релиз" }, capacityEnergy: null, risks: null, minimumSuccess: null, commitments: null, conclusionRequested: false },
    lastMessageAt: now,
  }] });
  const review = await weekly.service.build({ workspaceId: "workspace", userId: "user", timezone, query: "давай", now });
  assert.equal(review.modelMode, "deep");
  assert.equal(review.activeTopic.reviewKind, "weekly");
  assert.deepEqual(weekly.calls.briefings, [{ workspaceId: "workspace", kind: "weekly", localDate: "2026-09-04", timezone, now }]);
  assert.deepEqual(review.model.review, {
    kind: "weekly", questionsAsked: 1, questionLimit: 5, snapshot: "СНИМОК НЕДЕЛИ",
    state: { outcome: { status: "provided", summary: "релиз" }, capacityEnergy: null, risks: null, minimumSuccess: null, commitments: null, conclusionRequested: false },
  });
  assert.deepEqual(review.model.topic.active, { title: "Планирование недели", summary: "…", review: "weekly" });
});

test("a card focus and a pending proposal are rendered under the task's short id, never its UUID", async () => {
  const { service } = makeService();
  const result = await service.build({
    workspaceId: "workspace", userId: "user", timezone, query: "завтра в 10", now,
    focus: { occurrenceId: occurrenceRow.id, action: "reschedule" },
    pendingGroup: { groupId: "group-1", createdAt: new Date("2026-09-04T10:30:00Z"), titles: ["Создать задачу «Купить билеты»"] },
  });
  assert.deepEqual(result.model.hints, [{ task: "t1", kind: "reschedule_requested" }]);
  assert.deepEqual(result.model.pendingProposal, { askedAt: "04.09, 13:30", items: ["Создать задачу «Купить билеты»"] });
  assert.doesNotMatch(JSON.stringify(result.model), /group-1|00000000-0000-4000/);
});
