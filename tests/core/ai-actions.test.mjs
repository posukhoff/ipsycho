import test from "node:test";
import assert from "node:assert/strict";
import { actionDisposition, splitActionsByDisposition, validateActionBatchShape, validateMutationIntent } from "../../.core-dist/ai-actions.js";

const base = {
  type: "create_task",
  confidence: 0.95,
  criticalExplicit: false,
  habitModeExplicit: false,
  title: "Позвонить врачу",
  why: null,
  nextAction: null,
  context: "Важный нюанс задачи",
  definition: {
    kind: "task", importance: "normal", timeMode: "point", timezone: "Europe/Kyiv",
    plannedStartAt: "2026-08-10T12:00:00+03:00", plannedEndAt: null, plannedLocalDate: null,
    dueAt: null, dueLocalDate: null, fuzzyHorizonText: null, reviewAt: null,
    recurrenceRule: null, recurrenceTimezone: null, missPolicy: null, habitMode: false,
    minimumAction: null, desiredAction: null, habitTrigger: null,
  },
};

test("explicit create task applies immediately", () => {
  assert.equal(actionDisposition({ ...base, source: "user_explicit" }), "apply");
});

test("AI inferred create task requires confirmation", () => {
  assert.equal(actionDisposition({ ...base, source: "ai_inferred" }), "confirm");
});

test("task context stays an ordinary task field, not a separate memory action", () => {
  assert.equal(actionDisposition({ ...base, source: "user_explicit", context: "Сделать раньше дедлайна" }), "apply");
});

test("a goal link on a new task follows the same confidence boundary", () => {
  const goalLink = { goalId: "00000000-0000-4000-8000-000000000010", expectedGoalVersion: 1, confidence: 0.95 };
  assert.equal(actionDisposition({ ...base, source: "user_explicit", goalLink }), "apply");
  assert.equal(actionDisposition({ ...base, source: "user_explicit", goalLink: { ...goalLink, confidence: 0.89 } }), "confirm");
});

test("AI-proposed critical importance requires confirmation", () => {
  const action = {
    ...base,
    source: "user_explicit",
    criticalExplicit: false,
    definition: { ...base.definition, importance: "critical", timeMode: "deadline", plannedStartAt: null, dueAt: "2026-08-10T12:00:00+03:00" },
  };
  assert.equal(actionDisposition(action), "confirm");
});

test("explicit critical command may apply immediately", () => {
  const action = {
    ...base,
    source: "user_explicit",
    criticalExplicit: true,
    definition: { ...base.definition, importance: "critical", timeMode: "deadline", plannedStartAt: null, dueAt: "2026-08-10T12:00:00+03:00" },
  };
  assert.equal(actionDisposition(action), "apply");
});

test("AI-proposed habit mode requires confirmation", () => {
  const action = {
    ...base,
    source: "user_explicit",
    habitModeExplicit: false,
    definition: {
      ...base.definition,
      recurrenceRule: "FREQ=DAILY",
      recurrenceTimezone: "Europe/Kyiv",
      missPolicy: "expire",
      habitMode: true,
      minimumAction: "Почистить 30 секунд",
      desiredAction: "Почистить зубы",
    },
  };
  assert.equal(actionDisposition(action), "confirm");
});

test("explicit habit command may apply immediately", () => {
  const action = {
    ...base,
    source: "user_explicit",
    habitModeExplicit: true,
    definition: {
      ...base.definition,
      recurrenceRule: "FREQ=DAILY",
      recurrenceTimezone: "Europe/Kyiv",
      missPolicy: "expire",
      habitMode: true,
      minimumAction: "Почистить 30 секунд",
      desiredAction: "Почистить зубы",
    },
  };
  assert.equal(actionDisposition(action), "apply");
});

test("multi-task batch stays atomic when one item requires confirmation", () => {
  const a = { ...base, source: "user_explicit", title: "A" };
  const b = { ...base, source: "ai_inferred", title: "B" };
  const c = { ...base, source: "user_explicit", title: "C" };
  const result = splitActionsByDisposition([a, b, c]);
  assert.deepEqual(result.immediate, []);
  assert.deepEqual(result.pending.map((x) => x.title), ["A", "B", "C"]);
});

test("fully explicit multi-task batch applies atomically", () => {
  const actions = ["A", "B", "C"].map((title) => ({ ...base, source: "user_explicit", title }));
  const result = splitActionsByDisposition(actions);
  assert.deepEqual(result.immediate.map((x) => x.title), ["A", "B", "C"]);
  assert.deepEqual(result.pending, []);
});

test("a goal plan is one confirmable operation, never a mixed mutation batch", () => {
  const plan = {
    type: "create_goal_plan", source: "user_explicit", confidence: 1,
    goal: { title: "Поддерживать внешний вид", why: null, targetLocalDate: null },
    tasks: [{ ...base, title: "Миноксидил", source: "user_explicit", goalLink: null }],
  };
  assert.equal(actionDisposition(plan), "apply");
  assert.equal(validateActionBatchShape([plan, { ...base, source: "user_explicit" }]), "one message may create multiple tasks or memory items, but all other actions must be handled one at a time");
  assert.equal(actionDisposition({ ...plan, source: "ai_inferred" }), "confirm");
});


test("explicit update applies immediately unless critical was inferred", () => {
  const update = {
    type: "update_task",
    source: "user_explicit",
    confidence: 1,
    taskId: "00000000-0000-4000-8000-000000000001",
    expectedVersion: 1,
    criticalExplicit: false,
    patch: { title: "Новое название", why: null, nextAction: null, importance: null },
  };
  assert.equal(actionDisposition(update), "apply");
  assert.equal(actionDisposition({ ...update, patch: { ...update.patch, importance: "critical" } }), "confirm");
});

test("explicit completion and reschedule apply immediately", () => {
  assert.equal(actionDisposition({
    type: "complete_occurrence", source: "user_explicit", confidence: 1,
    occurrenceId: "00000000-0000-4000-8000-000000000002", expectedVersion: 1,
  }), "apply");
  assert.equal(actionDisposition({
    type: "reschedule_occurrence", source: "user_explicit", confidence: 1,
    occurrenceId: "00000000-0000-4000-8000-000000000003", expectedVersion: 1, reason: null,
    schedule: { timezone: "Europe/Kyiv", plannedStartAt: "2026-08-12T12:00:00+03:00", plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null },
  }), "apply");
});

test("chat settings apply only when explicit", () => {
  const settings = {
    type: "update_settings", source: "user_explicit", confidence: 1,
    expectedVersion: 1,
    operation: "digest", timezone: null, applyTimezoneTo: null, language: null,
    digestKind: "morning", enabled: true, time: "08:30", weekday: null,
    weekdayStart: null, weekdayEnd: null, weekendStart: null, weekendEnd: null,
    snoozeUntil: null, eventOffsets: null, plannedTaskOffsetMinutes: null,
    criticalPostDueMinutes: null, seenNormalMinutes: null, seenRequiredMinutes: null, seenCriticalMinutes: null,
  };
  assert.equal(actionDisposition(settings), "apply");
  assert.equal(actionDisposition({ ...settings, source: "ai_inferred" }), "confirm");
});

test("task-card operations apply only when explicit", () => {
  const action = {
    type: "update_occurrence", source: "user_explicit", confidence: 1,
    occurrenceId: "00000000-0000-4000-8000-000000000003", expectedVersion: 1,
    operation: "start", details: null,
  };
  assert.equal(actionDisposition(action), "apply");
  assert.equal(actionDisposition({ ...action, source: "ai_inferred" }), "confirm");
});


test("mutation batches stay intentionally single-action", () => {
  const update = {
    type: "update_task", source: "user_explicit", confidence: 1,
    taskId: "00000000-0000-4000-8000-000000000001", expectedVersion: 1, criticalExplicit: false,
    patch: { title: "X", why: null, nextAction: null, importance: null },
  };
  assert.match(validateActionBatchShape([update, update]), /one at a time/);
  assert.equal(validateActionBatchShape([{ ...base, source: "user_explicit" }, { ...base, source: "user_explicit", title: "B" }]), null);
});

test("memory and goal policies preserve confirmation boundaries", () => {
  assert.equal(actionDisposition({
    type: "save_memory", source: "user_explicit", confidence: 1,
    memoryType: "preference", content: "Люблю короткие ответы", sensitive: false,
  }), "apply");
  assert.equal(actionDisposition({
    type: "save_memory", source: "user_explicit", confidence: 1,
    memoryType: "context", content: "Чувствительный факт", sensitive: true,
  }), "confirm");
  assert.equal(actionDisposition({
    type: "create_goal", source: "ai_inferred", confidence: 0.95,
    title: "Научиться готовить", why: null, targetLocalDate: null,
  }), "confirm");
});

test("multiple memory items are accepted and confirmed as one batch when needed", () => {
  const publicMemory = {
    type: "save_memory", source: "user_explicit", confidence: 1,
    memoryType: "preference", content: "Люблю короткие ответы", sensitive: false,
  };
  const sensitiveMemory = {
    type: "save_memory", source: "user_explicit", confidence: 1,
    memoryType: "context", content: "Чувствительный факт", sensitive: true,
  };
  assert.equal(validateActionBatchShape([publicMemory, sensitiveMemory]), null);
  const result = splitActionsByDisposition([publicMemory, sensitiveMemory]);
  assert.deepEqual(result.immediate, []);
  assert.deepEqual(result.pending, [publicMemory, sensitiveMemory]);
});

test("informational questions cannot silently create a scheduled task", () => {
  const task = { ...base, source: "user_explicit", title: "Зайти в это приложение" };
  assert.match(validateMutationIntent([task], "Как это будет работать сейчас?"), /informational question/);
  assert.match(validateMutationIntent([task], "Как будут работать напоминания?"), /informational question/);
  assert.equal(validateMutationIntent([task], "Запланируй зайти в это приложение через минуту"), null);
});

test("informational questions cannot silently mutate settings or completion state", () => {
  const settings = {
    type: "update_settings", source: "user_explicit", confidence: 1, expectedVersion: 1,
    operation: "weekly_review", timezone: null, applyTimezoneTo: null, language: null,
    digestKind: null, enabled: true, time: "18:00", weekday: 7,
    weekdayStart: null, weekdayEnd: null, weekendStart: null, weekendEnd: null,
    snoozeUntil: null, eventOffsets: null, plannedTaskOffsetMinutes: null,
    criticalPostDueMinutes: null, seenNormalMinutes: null, seenRequiredMinutes: null, seenCriticalMinutes: null,
  };
  const completion = {
    type: "complete_occurrence", source: "user_explicit", confidence: 1,
    occurrenceId: "00000000-0000-4000-8000-000000000002", expectedVersion: 1,
  };
  assert.match(validateMutationIntent([settings], "У меня включён еженедельный обзор?"), /informational question/);
  assert.match(validateMutationIntent([completion], "Эта задача уже выполнена?"), /informational question/);
  assert.equal(validateMutationIntent([settings], "Можешь включить еженедельный обзор?"), null);
  assert.equal(validateMutationIntent([{ ...settings, source: "ai_inferred" }], "Как думаешь, стоит ли включить обзор?"), null);
});

test("high confidence inferred task-goal link applies, medium confidence confirms", () => {
  const link = {
    type: "link_task_to_goal", source: "ai_inferred", confidence: 0.95,
    taskId: "00000000-0000-4000-8000-000000000001", expectedTaskVersion: 1,
    goalId: "00000000-0000-4000-8000-000000000002", expectedGoalVersion: 1,
  };
  assert.equal(actionDisposition(link), "apply");
  assert.equal(actionDisposition({ ...link, confidence: 0.7 }), "confirm");
});


test("memory deletion always requires confirmation", () => {
  const action = {
    type: "delete_memory", source: "user_explicit", confidence: 1,
    memoryId: "00000000-0000-4000-8000-000000000001", expectedVersion: 1,
  };
  assert.equal(actionDisposition(action), "confirm");
});

test("a profile correction is always confirmed before replacing an existing fact", () => {
  const action = {
    type: "update_memory", source: "user_explicit", confidence: 1,
    memoryId: "00000000-0000-4000-8000-000000000001", expectedVersion: 1,
    patch: { content: "Обычно ложусь около 23:30", sensitive: false },
  };
  assert.equal(actionDisposition(action), "confirm");
  assert.equal(actionDisposition({ ...action, source: "ai_inferred" }), "confirm");
  assert.match(validateActionBatchShape([action, action]), /one at a time/);
});

test("reminder changes respect explicit quiet-hours bypass", () => {
  const baseReminder = {
    type: "change_reminder", source: "user_explicit", confidence: 1,
    occurrenceId: "00000000-0000-4000-8000-000000000010", expectedVersion: 1,
    mode: "replace", quietBypassExplicit: false,
    reminder: { triggerKind: "exact", exactAt: "2026-08-12T12:00:00+03:00", anchor: null, offsetMinutes: null, quietPolicy: "respect" },
  };
  assert.equal(actionDisposition(baseReminder), "apply");
  assert.equal(actionDisposition({ ...baseReminder, source: "ai_inferred" }), "confirm");
  assert.equal(actionDisposition({ ...baseReminder, reminder: { ...baseReminder.reminder, quietPolicy: "bypass" } }), "confirm");
  assert.equal(actionDisposition({ ...baseReminder, quietBypassExplicit: true, reminder: { ...baseReminder.reminder, quietPolicy: "bypass" } }), "apply");
});

test("series changes are immediate only when explicitly requested", () => {
  const action = {
    type: "change_series", source: "user_explicit", confidence: 1,
    taskId: "00000000-0000-4000-8000-000000000011", expectedVersion: 1,
    operation: "pause", edit: null,
  };
  assert.equal(actionDisposition(action), "apply");
  assert.equal(actionDisposition({ ...action, source: "ai_inferred" }), "confirm");
});

test("goal updates follow explicit versus inferred action policy", () => {
  const action = {
    type: "update_goal", source: "user_explicit", confidence: 1,
    goalId: "00000000-0000-4000-8000-000000000012", expectedVersion: 1,
    patch: { title: null, why: null, targetLocalDate: null, status: "paused", reviewEnabled: null },
  };
  assert.equal(actionDisposition(action), "apply");
  assert.equal(actionDisposition({ ...action, source: "ai_inferred" }), "confirm");
});
