import test from "node:test";
import assert from "node:assert/strict";
import { AiTurnSchema, AI_ACTION_TYPES, ResolvedActionSchema, WhenSchema } from "../../dist/ai/ai-contracts.js";
import { DEEPSEEK_JSON_INSTRUCTION } from "../../dist/ai/deepseek.provider.js";

const turn = (actions, overrides = {}) => ({
  reply: "Записал.",
  question: null,
  actions,
  topic: { mode: "none", title: null, summary: null },
  ...overrides,
});

const exact = { mode: "exact", date: "2026-09-10", time: "09:30", durationMinutes: null };

const taskBody = (overrides = {}) => ({
  title: "Позвонить врачу",
  why: null,
  nextAction: null,
  context: null,
  checklist: null,
  importance: "normal",
  kind: "task",
  when: exact,
  recurrence: null,
  reminder: null,
  habit: null,
  timezone: null,
  ...overrides,
});

const actions = {
  create_task: { type: "create_task", intent: "explicit", ...taskBody(), goal: null },
  update_task: {
    type: "update_task",
    intent: "explicit",
    task: { id: "t1" },
    patch: { title: "Новое имя", why: null, nextAction: null, context: null, checklist: null, importance: null, habit: null },
  },
  set_task_state: { type: "set_task_state", intent: "explicit", task: { id: "t2" }, state: "done", note: null, scope: null },
  reschedule: {
    type: "reschedule",
    intent: "explicit",
    task: { id: "t3" },
    when: { mode: "date", date: "2026-09-11" },
    reason: null,
    scope: null,
    recurrence: null,
    timezone: null,
  },
  set_reminder: { type: "set_reminder", intent: "explicit", task: { id: "t1" }, mode: "replace", reminder: { kind: "offset", anchor: "start", minutes: -30, quiet: "respect" } },
  goal: { type: "goal", intent: "inferred", op: "link", goal: { id: "g1" }, task: { id: "t1" }, title: null, why: null, targetDate: null, status: null, reviewEnabled: null },
  plan: { type: "plan", intent: "explicit", goal: { title: "Выучить испанский", why: null, targetDate: "2026-12-31" }, tasks: [taskBody({ title: "Найти преподавателя" })] },
  memory: { type: "memory", intent: "explicit", op: "save", item: null, kind: "preference", content: "Предпочитает встречи утром", sensitive: false },
  settings: {
    type: "settings",
    intent: "explicit",
    operation: "digest",
    timezone: null,
    applyTimezoneTo: null,
    language: null,
    digestKind: "morning",
    enabled: true,
    time: "08:30",
    weekday: null,
    weekdayStart: null,
    weekdayEnd: null,
    weekendStart: null,
    weekendEnd: null,
    snoozeUntilDate: null,
    snoozeUntilTime: null,
    eventOffsets: null,
    plannedTaskOffsetMinutes: null,
    criticalPostDueMinutes: null,
    seenNormalMinutes: null,
    seenRequiredMinutes: null,
    seenCriticalMinutes: null,
  },
};

test("the contract names exactly nine action types", () => {
  assert.deepEqual([...AI_ACTION_TYPES].sort(), Object.keys(actions).sort());
});

for (const [type, action] of Object.entries(actions)) {
  test(`AiTurnSchema accepts a ${type} action`, () => {
    const parsed = AiTurnSchema.parse(turn([action]));
    assert.equal(parsed.actions[0].type, type);
    assert.equal(parsed.actions[0].intent, action.intent);
  });
}

test("AiTurnSchema accepts one atomic package mixing several action types", () => {
  const parsed = AiTurnSchema.parse(turn([actions.create_task, actions.goal, actions.reschedule, actions.memory]));
  assert.deepEqual(
    parsed.actions.map((action) => action.type),
    ["create_task", "goal", "reschedule", "memory"],
  );
});

const whens = {
  exact,
  "exact with duration": { ...exact, durationMinutes: 90 },
  date: { mode: "date", date: "2026-09-10" },
  "deadline with time": { mode: "deadline", date: "2026-09-10", time: "18:00" },
  "deadline without time": { mode: "deadline", date: "2026-09-10", time: null },
  fuzzy: { mode: "fuzzy", horizonText: "к осени", reviewDate: "2026-09-20" },
};

for (const [label, when] of Object.entries(whens)) {
  test(`WhenSchema accepts ${label}`, () => {
    assert.deepEqual(WhenSchema.parse(when), when);
    assert.equal(AiTurnSchema.safeParse(turn([{ ...actions.create_task, when }])).success, true);
  });
}

test("When never carries an ISO instant, a timezone, or a review time", () => {
  assert.equal(WhenSchema.safeParse({ mode: "exact", date: "2026-09-10T09:30:00Z", time: "09:30", durationMinutes: null }).success, false);
  assert.equal(WhenSchema.safeParse({ mode: "exact", date: "2026-09-10", time: "09:30:00", durationMinutes: null }).success, false);
  assert.equal(WhenSchema.safeParse({ ...exact, timezone: "Europe/Kyiv" }).success, false);
  assert.equal(WhenSchema.safeParse({ mode: "fuzzy", horizonText: "к осени", reviewDate: "2026-09-20", reviewTime: "09:00" }).success, false);
  assert.equal(WhenSchema.safeParse({ mode: "window", date: "2026-09-10" }).success, false);
});

test("the strict contract rejects every field of the old schema", () => {
  const rejected = [
    turn([{ ...actions.create_task, expectedVersion: 1 }]),
    turn([{ ...actions.create_task, source: "user_explicit", confidence: 1 }]),
    turn([{ ...actions.create_task, criticalExplicit: true }]),
    turn([{ ...actions.set_task_state, occurrenceId: "00000000-0000-4000-8000-000000000003" }]),
    turn([{ type: "task_batch", intent: "explicit", steps: [] }]),
    turn([
      {
        ...actions.create_task,
        recurrence: { frequency: "daily", interval: 1, weekdays: null, monthDays: null, until: null, skipDates: null, missed: null, localTimes: ["09:00"] },
      },
    ]),
    turn([
      {
        ...actions.create_task,
        recurrence: { frequency: "daily", interval: 1, weekdays: null, monthDays: null, until: null, skipDates: null, missed: null, startsOn: "2026-09-10" },
      },
    ]),
    turn([{ ...actions.create_task, definition: { timeMode: "point" } }]),
    turn([], { topic: { mode: "switch", title: null, summary: null } }),
    turn([], { topic: { mode: "continue", topicId: "00000000-0000-4000-8000-000000000009", title: null, summary: null } }),
    turn([], { topicModeSuggestion: "analysis" }),
    turn([], { profileInvitation: false }),
    turn([{ type: "update_settings", intent: "explicit", operation: "digest" }]),
    turn([{ ...actions.create_task, intent: "user_explicit" }]),
    turn([{ ...actions.update_task, task: { id: "00000000-0000-4000-8000-000000000001" } }]),
    turn([{ ...actions.update_task, task: { id: "t1", version: 2 } }]),
  ];
  for (const [index, candidate] of rejected.entries()) {
    assert.equal(AiTurnSchema.safeParse(candidate).success, false, `candidate #${index} should be rejected`);
  }
});

test("a turn carries at most eight actions and always a topic directive", () => {
  assert.equal(AiTurnSchema.safeParse(turn(Array.from({ length: 9 }, () => actions.memory))).success, false);
  assert.equal(AiTurnSchema.safeParse({ reply: "ok", question: null, actions: [] }).success, false);
  assert.equal(AiTurnSchema.safeParse(turn([], { topic: { mode: "new", title: "Отпуск", summary: "Планируем сентябрь" } })).success, true);
});

test("timezone changes still require an explicit profile-versus-notifications scope only in conversion, not in the schema", () => {
  const timezone = { ...actions.settings, operation: "timezone", timezone: "Europe/Kyiv", digestKind: null, enabled: null, time: null };
  assert.equal(AiTurnSchema.safeParse(turn([timezone])).success, true);
  assert.equal(AiTurnSchema.safeParse(turn([{ ...timezone, applyTimezoneTo: "all" }])).success, true);
  assert.equal(AiTurnSchema.safeParse(turn([{ ...timezone, snoozeUntil: "2026-09-11T10:00:00Z" }])).success, false);
});

test("ResolvedActionSchema accepts a resolved create_task and set_task_state", () => {
  const base = { intent: "explicit", timezone: "Europe/Kyiv", reviewTime: "09:00" };
  const created = ResolvedActionSchema.parse({
    type: "create_task",
    ...base,
    body: taskBody(),
    goal: { goalId: "00000000-0000-4000-8000-000000000010", goalVersion: 3 },
  });
  assert.equal(created.body.title, "Позвонить врачу");
  const done = ResolvedActionSchema.parse({
    type: "set_task_state",
    ...base,
    state: "done",
    note: null,
    target: {
      kind: "occurrence",
      taskId: "00000000-0000-4000-8000-000000000001",
      taskVersion: 4,
      occurrenceId: "00000000-0000-4000-8000-000000000002",
      occurrenceVersion: 1,
      timezone: "Europe/Kyiv",
    },
  });
  assert.equal(done.target.kind, "occurrence");
  assert.equal(ResolvedActionSchema.safeParse({ type: "set_task_state", ...base, state: "done", note: null, task: { id: "t1" } }).success, false);
});

test("DeepSeek manual JSON contract mentions all nine action types and intent", () => {
  for (const type of AI_ACTION_TYPES) assert.match(DEEPSEEK_JSON_INSTRUCTION, new RegExp(`\\b${type}\\b`), type);
  assert.match(DEEPSEEK_JSON_INSTRUCTION, /intent/);
  assert.match(DEEPSEEK_JSON_INSTRUCTION, /"explicit"/);
  assert.match(DEEPSEEK_JSON_INSTRUCTION, /"inferred"/);
  assert.doesNotMatch(DEEPSEEK_JSON_INSTRUCTION, /expectedVersion|task_batch|occurrenceId|localTimes|criticalExplicit/);
});
