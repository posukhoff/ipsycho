import test from "node:test";
import assert from "node:assert/strict";
import { ChatService, appendAppliedTiming } from "../../dist/chat/chat.service.js";
import { mutationReportItems } from "../../dist/actions/actions.service.js";

const inferredTask = {
  type: "create_task", source: "ai_inferred", confidence: 0.8, criticalExplicit: false, habitModeExplicit: false,
  title: "Подготовить короткий оффер", why: null, nextAction: null, context: null, checklist: null, goalLink: null,
  definition: {
    kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv",
    plannedStartAt: "2026-09-01T06:00:00Z", plannedEndAt: null, plannedLocalDate: null,
    dueAt: null, dueLocalDate: null, fuzzyHorizonText: null, reviewAt: null,
    recurrenceRule: null, recurrenceTimezone: null, missPolicy: null, habitMode: false,
    minimumAction: null, desiredAction: null, habitTrigger: null,
  },
};

function turn(actions, reply) {
  return {
    reply, question: null, actions, goalAnalysisFocus: null, reviewProgress: null,
    topic: { mode: "none", topicId: null, title: null, summary: null },
    topicModeSuggestion: "normal", profileInvitation: false,
  };
}

function harness(responses, batchEnabled = false) {
  const statuses = [];
  const proposed = [];
  let calls = 0;
  const ai = {
    providerName: "openai", consentVersion: "v1", maxMessagesPerHour: 20, maxCallsPerHour: 20,
    isConfigured: () => true, hasConsent: async () => true, callsLastHour: async () => 0,
    respond: async () => responses[calls++],
  };
  const actions = {
    isTaskBatchEnabled: () => batchEnabled,
    validate: async () => [],
    handleProposed: async (drafts) => { proposed.push(drafts); return {}; },
  };
  const messages = {
    saveOnce: async ({ content }) => ({ inserted: true, message: { id: "message-1", content } }),
    countUserMessagesSince: async () => 0,
    isAiProcessingAllowed: async () => true,
    listRecentForAi: async () => [],
    setStatus: async (...args) => { statuses.push(args); },
  };
  const context = {
    buildAiContext: async () => ({
      topics: [], goals: [], goalResolution: { requested: false, state: "none", candidates: [] },
      modelMode: "normal",
    }),
    validateTopicDirective: async () => null,
    applyTopicDirective: async () => null,
  };
  const tasks = { getAiContext: async () => [] };
  return { chat: new ChatService(ai, actions, messages, tasks, context, {}), statuses, proposed, calls: () => calls };
}

test("low-energy planning advice repairs away inferred actions before a pending group can be stored", async () => {
  const h = harness([
    turn([inferredTask], "Предлагаю три маленьких шага. Если хочешь, могу создать задачи."),
    turn([], "Предлагаю три маленьких шага, но пока ничего не меняю."),
  ]);
  const result = await h.chat.processText({
    workspaceId: "workspace-1", userId: "user-1", aiStatus: "enabled", timezone: "Europe/Kyiv", language: "ru",
    text: "Продукт почти готов, но есть только четыре часа и мало энергии",
    telegramChatId: 1, telegramMessageId: 1,
  });
  assert.equal(result.kind, "ok");
  assert.equal(result.pendingCount, 0);
  assert.equal(result.appliedCount, 0);
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.proposed, [[]]);
});

test("disabled mixed request bypasses the provider and cannot create an action group", async () => {
  const h = harness([]);
  const result = await h.chat.processText({
    workspaceId: "workspace-1", userId: "user-1", aiStatus: "enabled", timezone: "Europe/Kyiv", language: "ru",
    text: "Создай задачу подготовить оффер, перенеси встречу на четверг в 16:00 и привяжи задачу к цели",
    telegramChatId: 1, telegramMessageId: 2,
  });
  assert.equal(result.kind, "ok");
  assert.equal(result.pendingCount, 0);
  assert.equal(result.appliedCount, 0);
  assert.match(result.text, /ничего не изменил/);
  assert.equal(h.calls(), 0);
  assert.deepEqual(h.proposed, []);
});

test("applied confirmation is built from persisted results, not from the model's prose", () => {
  // Production 2026-08-23: "Готово." hid that the wrong task had been renamed, and "напомню в 17:30"
  // was never backed by a stored reminder.
  const now = new Date("2026-08-23T07:09:00Z");
  const occurrence = { timezone: "Europe/Kyiv", plannedStartAt: new Date("2026-08-23T15:00:00Z"), plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null };
  const applied = {
    groupId: "g", count: 2, titles: ["Вакцинация", "Записаться на вакцинацию Морти"],
    items: [
      { kind: "task_created", title: "Вакцинация", timezone: "Europe/Kyiv", schedule: occurrence, reminderAt: new Date("2026-08-23T14:30:00Z") },
      { kind: "task_created", title: "Записаться на вакцинацию Морти", timezone: "Europe/Kyiv", schedule: { ...occurrence, plannedStartAt: new Date("2027-08-23T07:00:00Z") }, reminderAt: new Date("2027-08-23T07:00:00Z") },
    ],
  };
  assert.equal(
    appendAppliedTiming("Поставил.", [], applied, now),
    "Поставил.\n\n✅ Создано задач: 2\n1. «Вакцинация» — 📅 23.08, 18:00 (Europe/Kyiv) · 🔔 17:30\n2. «Записаться на вакцинацию Морти» — 📅 23.08.2027, 10:00 (Europe/Kyiv) · 🔔 в момент начала",
  );
  const renamed = {
    groupId: "g", count: 1, titles: ["Ежегодная вакцинация собаки"],
    items: [{ kind: "task_updated", title: "Ежегодная вакцинация собаки", changes: [{ field: "title", before: "Контрольное напоминание о вакцинации", after: "Ежегодная вакцинация собаки" }] }],
  };
  assert.equal(appendAppliedTiming("Готово.", [], renamed, now), "Готово.\n\n✏️ Задача «Ежегодная вакцинация собаки»\n• Название: «Контрольное напоминание о вакцинации» → «Ежегодная вакцинация собаки»");
  // Results without report items still show the persisted timing facts.
  const legacyCreate = { type: "create_task", source: "user_explicit", confidence: 1, title: "Вакцинация", definition: { timezone: "Europe/Kyiv" } };
  assert.equal(
    appendAppliedTiming("Ок.", [legacyCreate], { groupId: "g", count: 1, titles: ["Вакцинация"], occurrenceSchedule: occurrence, scheduledReminderAt: new Date("2026-08-23T14:30:00Z") }, now),
    "Ок.\n\n📅 Запланировано: 23.08, 18:00 (Europe/Kyiv)\n🔔 Напоминание: 23.08, 17:30 (Europe/Kyiv)",
  );
});

test("mutation results map to report items with the repository's before/after facts", () => {
  const occurrence = { timezone: "Europe/Kyiv", plannedStartAt: new Date("2026-08-24T07:00:00Z"), plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null };
  const reschedule = { type: "reschedule_occurrence", source: "user_explicit", confidence: 1, occurrenceId: "o", expectedVersion: 1, reason: "перенос", schedule: {} };
  assert.deepEqual(
    mutationReportItems(reschedule, { groupId: "g", count: 1, titles: ["Созвон"], previousSchedule: { ...occurrence, plannedStartAt: new Date("2026-08-23T15:00:00Z") }, occurrenceSchedule: occurrence, scheduledReminderAt: new Date("2026-08-24T06:30:00Z") }),
    [{ kind: "task_rescheduled", title: "Созвон", before: { ...occurrence, plannedStartAt: new Date("2026-08-23T15:00:00Z") }, after: occurrence, reminderAt: new Date("2026-08-24T06:30:00Z"), reason: "перенос" }],
  );
  const link = { type: "link_task_to_goal", source: "user_explicit", confidence: 1, taskId: "t", expectedTaskVersion: 1, goalId: "g", expectedGoalVersion: 1 };
  assert.deepEqual(mutationReportItems(link, { groupId: "g", count: 1, titles: ["Связать «Зарядка» с целью «Здоровье»"] }), [{ kind: "goal_linked", taskTitle: "Зарядка", goalTitle: "Здоровье" }]);
  const seen = { type: "update_occurrence", source: "user_explicit", confidence: 1, occurrenceId: "o", expectedVersion: 1, operation: "record_blocker", details: "нет данных" };
  assert.deepEqual(mutationReportItems(seen, { groupId: "g", count: 1, titles: ["Отчёт"] }), [{ kind: "occurrence", title: "Отчёт", operation: "record_blocker", details: "нет данных" }]);
});
