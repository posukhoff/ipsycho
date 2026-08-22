import test from "node:test";
import assert from "node:assert/strict";
import { AiTurnSchema } from "../../dist/ai/ai-contracts.js";
import { DEEPSEEK_JSON_INSTRUCTION } from "../../dist/ai/deepseek.provider.js";

const baseTurn = (reply, action) => ({
  reply, question: null, profileInvitation: false,
  topic: { mode: "none", topicId: null, title: null, summary: null },
  topicModeSuggestion: null, actions: [action],
});

const settingsAction = {
  type: "update_settings", source: "user_explicit", confidence: 1, expectedVersion: 3,
  operation: "digest", timezone: null, applyTimezoneTo: null, language: null,
  digestKind: "morning", enabled: true, time: "08:30", weekday: null,
  weekdayStart: null, weekdayEnd: null, weekendStart: null, weekendEnd: null,
  snoozeUntil: null, eventOffsets: null, plannedTaskOffsetMinutes: null,
  criticalPostDueMinutes: null, seenNormalMinutes: null, seenRequiredMinutes: null, seenCriticalMinutes: null,
};

for (const reply of ["Утреннюю сводку включил.", "Ранкове зведення ввімкнено.", "Morning briefing enabled."]) {
  test(`structured settings contract accepts ${reply}`, () => {
    assert.equal(AiTurnSchema.parse(baseTurn(reply, settingsAction)).actions[0].type, "update_settings");
  });
}

test("structured settings contract accepts a weekly-review schedule", () => {
  const weekly = {
    ...settingsAction,
    operation: "weekly_review",
    digestKind: null,
    weekday: 7,
    time: "18:00",
  };
  assert.equal(AiTurnSchema.parse(baseTurn("Еженедельный обзор включён.", weekly)).actions[0].operation, "weekly_review");
});

test("timezone changes require an explicit profile-versus-notifications scope", () => {
  const timezone = {
    ...settingsAction,
    operation: "timezone",
    timezone: "Europe/Kyiv",
    digestKind: null,
    enabled: null,
    time: null,
  };
  assert.equal(AiTurnSchema.safeParse(baseTurn("Меняю часовой пояс.", timezone)).success, false);
  assert.equal(AiTurnSchema.safeParse(baseTurn("Меняю часовой пояс везде.", { ...timezone, applyTimezoneTo: "all" })).success, true);
});

test("DeepSeek manual JSON contract includes every newly supported action", () => {
  assert.match(DEEPSEEK_JSON_INSTRUCTION, /update_settings/);
  assert.match(DEEPSEEK_JSON_INSTRUCTION, /update_occurrence/);
  assert.match(DEEPSEEK_JSON_INSTRUCTION, /checklist/);
  assert.match(DEEPSEEK_JSON_INSTRUCTION, /expectedVersion/);
});
