import test from "node:test";
import assert from "node:assert/strict";
import { budgetModelContext, composeTurnContext, selectTasksForContext, currentOccurrence } from "../../.core-dist/turn-context.js";
import { formatWhenForModel, relativeDayLabel } from "../../.core-dist/time-presentation.js";
import { formatCurrentTimeLine } from "../../.core-dist/ai-time-context.js";

// Friday 2026-09-04 14:05 in Kyiv (UTC+3).
const now = new Date("2026-09-04T11:05:00Z");
const timezone = "Europe/Kyiv";

const task = (id, overrides = {}) => ({
  id,
  version: 1,
  title: `Задача ${id}`,
  kind: "task",
  importance: "normal",
  status: "active",
  timeMode: "point",
  timezone,
  plannedStartAt: null,
  plannedEndAt: null,
  plannedLocalDate: null,
  dueAt: null,
  dueLocalDate: null,
  fuzzyHorizonText: null,
  reviewAt: null,
  recurrenceRule: null,
  recurrenceEndLocalDate: null,
  habitMode: false,
  habitOfferSentAt: null,
  ...overrides,
});
const occurrence = (taskId, overrides = {}) => ({
  id: `occ-${taskId}`,
  taskId,
  status: "scheduled",
  timezone,
  plannedStartAt: null,
  plannedEndAt: null,
  plannedLocalDate: null,
  dueAt: null,
  dueLocalDate: null,
  overdue: false,
  ...overrides,
});
const settingsRow = {
  timezone,
  pinnedLanguage: null,
  morningDigestEnabled: true,
  morningReferenceTime: "09:00",
  eveningDigestEnabled: false,
  eveningReferenceTime: "20:00",
  weeklyReviewEnabled: true,
  weeklyReviewWeekday: 7,
  weeklyReviewTime: "20:00",
  quietHoursEnabled: true,
  weekdayQuietStart: "22:00",
  weekdayQuietEnd: "08:00",
  weekendQuietStart: "23:00",
  weekendQuietEnd: "09:00",
  notificationsSnoozedUntil: null,
  eventReminderOffsetsMinutes: [-60, -15],
  plannedTaskReminderOffsetMinutes: 0,
  criticalPostDueMinutes: 60,
  version: 7,
};
const compose = (overrides = {}) =>
  composeTurnContext({
    now,
    timezone,
    tasks: [],
    tasksTotal: 0,
    truncated: false,
    occurrencesByTask: new Map(),
    goals: [],
    taskGoalLinks: [],
    profile: [],
    memoryMatches: [],
    settings: null,
    topics: [],
    ...overrides,
  });

test("over the limit the model sees the nearest tasks plus message matches, t1 is the nearest", () => {
  const tasks = [];
  const occurrencesByTask = new Map();
  for (let index = 0; index < 120; index += 1) {
    const id = `task-${index}`;
    // Insert out of order so the sort, not the input order, decides t1.
    tasks.unshift(task(id));
    occurrencesByTask.set(id, [occurrence(id, { plannedStartAt: new Date(now.getTime() + (index + 1) * 3_600_000) })]);
  }
  const selection = selectTasksForContext(tasks, occurrencesByTask, new Set(["task-110"]), { now, timezone });
  assert.equal(selection.total, 120);
  assert.equal(selection.truncated, true);
  assert.equal(selection.shown.length, 41);
  assert.equal(selection.shown[0].id, "task-0");
  assert.equal(selection.shown.at(-1).id, "task-110");

  const { model, refs } = compose({ tasks: selection.shown, tasksTotal: selection.total, truncated: selection.truncated, occurrencesByTask });
  assert.equal(model.tasks[0].id, "t1");
  assert.equal(model.tasks[0].title, "Задача task-0");
  assert.equal(model.tasks[0].when, "сегодня 15:05");
  assert.equal(model.tasks[40].id, "t41");
  assert.equal(refs.tasks.get("t41").id, "task-110");
  assert.match(model.tasksNote, /Показаны 41 из 120 активных задач/);
});

test("under the limit every task is shown, sorted by time with unscheduled ones last", () => {
  const tasks = [
    task("later", { plannedStartAt: new Date("2026-09-06T07:00:00Z") }),
    task("none"),
    task("fuzzy", { timeMode: "fuzzy", fuzzyHorizonText: "на этой неделе", reviewAt: new Date("2026-09-05T06:00:00Z") }),
    task("soon"),
  ];
  const occurrencesByTask = new Map([["soon", [occurrence("soon", { plannedStartAt: new Date("2026-09-04T15:00:00Z") })]]]);
  const selection = selectTasksForContext(tasks, occurrencesByTask, new Set(), { now, timezone });
  assert.deepEqual(
    selection.shown.map((item) => item.id),
    ["soon", "fuzzy", "later", "none"],
  );
  assert.equal(selection.truncated, false);
  const { model } = compose({ tasks: selection.shown, tasksTotal: 4, occurrencesByTask });
  assert.equal(model.tasksNote, undefined);
  assert.deepEqual(
    model.tasks.map((item) => item.when),
    ["сегодня 18:00", "~ «на этой неделе», пересмотр завтра", "вс 06.09 10:00", "без времени"],
  );
});

test("goal, checklist and focus collapse onto the task line and hints", () => {
  const tasks = [task("call", { recurrenceRule: "FREQ=WEEKLY;BYDAY=MO", importance: "required" }), task("report", { kind: "event" })];
  const occurrencesByTask = new Map([
    ["call", [occurrence("call", { plannedStartAt: new Date("2026-09-07T07:00:00Z") })]],
    ["report", [occurrence("report", { plannedStartAt: new Date("2026-09-05T07:00:00Z"), plannedEndAt: new Date("2026-09-05T08:00:00Z") })]],
  ]);
  const { model, refs } = compose({
    tasks: selectTasksForContext(tasks, occurrencesByTask, new Set(), { now, timezone }).shown,
    tasksTotal: 2,
    occurrencesByTask,
    checklistByTask: new Map([["call", [{ done: true }, { done: true }, { done: false }, { done: false }, { done: false }]]]),
    goals: [{ id: "goal-1", version: 2, title: "Запустить продукт", why: "чтобы", status: "active", targetLocalDate: "2026-10-01" }],
    taskGoalLinks: [
      { taskId: "call", goalId: "goal-1" },
      { taskId: "missing", goalId: "goal-1" },
    ],
    focus: { taskId: "report" },
  });
  const [report, call] = model.tasks;
  assert.deepEqual(report, { id: "t1", title: "Задача report", when: "завтра 10:00–11:00", kind: "event" });
  assert.deepEqual(call, {
    id: "t2",
    title: "Задача call",
    when: "пн 07.09 10:00",
    importance: "required",
    repeat: "каждую неделю: пн",
    goal: "g1",
    checklist: "2/5",
  });
  assert.deepEqual(model.goals, [{ id: "g1", title: "Запустить продукт", why: "чтобы", targetDate: "2026-10-01", tasks: ["t2"] }]);
  assert.deepEqual(model.hints, [
    { task: "t2", kind: "habit_offer" },
    { task: "t1", kind: "reschedule_requested" },
  ]);
  assert.deepEqual(refs.tasks.get("t2"), { id: "call", version: 1, title: "Задача call", timeMode: "point", recurring: true, status: "active" });
  assert.deepEqual(refs.goals.get("g1"), { id: "goal-1", version: 2, title: "Запустить продукт" });
});

test("task state reflects the current occurrence and the series", () => {
  const tasks = [task("running"), task("late"), task("paused", { status: "paused" })];
  const occurrencesByTask = new Map([
    ["running", [occurrence("running", { status: "in_progress", plannedStartAt: new Date("2026-09-04T09:00:00Z") })]],
    ["late", [occurrence("late", { status: "open", dueAt: new Date("2026-09-04T08:00:00Z"), overdue: true })]],
    ["paused", [occurrence("paused", { plannedStartAt: new Date("2026-09-08T09:00:00Z") })]],
  ]);
  const { model } = compose({
    tasks,
    tasksTotal: 3,
    occurrencesByTask,
  });
  assert.deepEqual(Object.fromEntries(model.tasks.map((line) => [line.title, line.state])), {
    "Задача running": "in_progress",
    "Задача late": "overdue",
    "Задача paused": "paused_series",
  });
  assert.equal(model.hints, undefined);
  assert.equal(model.tasks.find((line) => line.title === "Задача late").when, "до сегодня, 11:00");
});

test("current occurrence prefers in_progress, then open, then the earliest scheduled", () => {
  const rows = [
    occurrence("x", { id: "later", plannedStartAt: new Date("2026-09-10T09:00:00Z") }),
    occurrence("x", { id: "soon", plannedStartAt: new Date("2026-09-05T09:00:00Z") }),
    occurrence("x", { id: "open", status: "open", plannedStartAt: new Date("2026-09-06T09:00:00Z") }),
    occurrence("x", { id: "done", status: "done" }),
  ];
  assert.equal(currentOccurrence(rows).id, "open");
  assert.equal(currentOccurrence(rows.filter((row) => row.id !== "open")).id, "soon");
  assert.equal(currentOccurrence([]), null);
});

test("sensitive memory never reaches the model; profile facts come first, matches are capped at five", () => {
  const item = (id, extra = {}) => ({ id, version: 1, type: "note", content: `факт ${id}`, sensitive: false, ...extra });
  const { model, refs } = compose({
    profile: [item("p1", { type: "context" }), item("secret", { type: "context", sensitive: true, content: "Секретный личный факт" })],
    memoryMatches: [item("p1", { type: "context" }), item("s2", { sensitive: true, content: "Диагноз" }), ...[1, 2, 3, 4, 5, 6].map((n) => item(`m${n}`))],
  });
  assert.deepEqual(
    model.memory.map((line) => line.id),
    ["m1", "m2", "m3", "m4", "m5", "m6"],
  );
  assert.deepEqual(model.memory[0], { id: "m1", type: "context", content: "факт p1" });
  assert.deepEqual(refs.memory.get("m1"), { id: "p1", version: 1, title: "факт p1" });
  const serialized = JSON.stringify(model);
  assert.doesNotMatch(serialized, /Секретный личный факт|Диагноз|факт m6/);
});

test("settings are human-readable without a version and the context carries no ISO instants", () => {
  const { model } = compose({
    settings: { ...settingsRow, notificationsSnoozedUntil: new Date("2026-09-04T16:00:00Z") },
    topics: [
      { id: "t-active", title: "Отпуск", summary: "Планируем отпуск", status: "active", reviewKind: "evening", clarificationCount: 1, lastMessageAt: now },
      { id: "t-old", title: "Старое", summary: "давно", status: "paused", reviewKind: null, clarificationCount: 0, lastMessageAt: new Date("2026-08-01T00:00:00Z") },
      { id: "t-new", title: "Недавнее", summary: "вчера", status: "paused", reviewKind: null, clarificationCount: 0, lastMessageAt: new Date("2026-09-03T00:00:00Z") },
      { id: "t-resolved", title: "Закрыто", summary: "всё", status: "resolved", reviewKind: null, clarificationCount: 0, lastMessageAt: now },
    ],
    pendingProposal: { createdAt: new Date("2026-09-04T10:00:00Z"), titles: ["Создать задачу «Позвонить»"] },
  });
  assert.deepEqual(model.settings, {
    timezone,
    language: "auto",
    morningDigest: "09:00",
    eveningDigest: "off",
    weeklyReview: "вс 20:00",
    quietHours: { enabled: true, weekdayStart: "22:00", weekdayEnd: "08:00", weekendStart: "23:00", weekendEnd: "09:00" },
    snoozedUntil: "04.09, 19:00",
    reminderDefaults: {
      eventOffsetsMinutes: [-60, -15],
      plannedTaskOffsetMinutes: 0,
      criticalPostDueMinutes: 60,
    },
  });
  assert.equal("version" in model.settings, false);
  assert.deepEqual(model.topic, {
    active: { title: "Отпуск", summary: "Планируем отпуск" },
    recent: [
      { title: "Недавнее", summary: "вчера" },
      { title: "Старое", summary: "давно" },
    ],
  });
  assert.deepEqual(model.pendingProposal, { askedAt: "04.09, 13:00", items: ["Создать задачу «Позвонить»"] });
  assert.equal("review" in model, false, "a review frame is no longer part of the model context");
  assert.doesNotMatch(JSON.stringify(model), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
});

test("when is pre-formatted local text for every schedule shape", () => {
  const cases = [
    [{ plannedStartAt: new Date("2026-09-04T15:00:00Z") }, "сегодня 18:00"],
    [{ plannedStartAt: new Date("2026-09-05T07:00:00Z"), plannedEndAt: new Date("2026-09-05T08:00:00Z") }, "завтра 10:00–11:00"],
    [{ plannedStartAt: new Date("2026-09-05T20:00:00Z"), plannedEndAt: new Date("2026-09-06T06:00:00Z") }, "завтра 23:00 – вс 06.09 09:00"],
    [{ plannedLocalDate: "2026-09-12" }, "сб 12.09"],
    [{ plannedLocalDate: "2027-01-10" }, "вс 10.01.2027"],
    [{ dueAt: new Date("2026-09-12T15:00:00Z") }, "до сб 12.09, 18:00"],
    [{ dueLocalDate: "2026-09-03" }, "до вчера"],
    [{ fuzzyHorizonText: "на этой неделе", reviewAt: new Date("2026-09-12T06:00:00Z") }, "~ «на этой неделе», пересмотр сб 12.09"],
    [{ fuzzyHorizonText: "когда-нибудь" }, "~ «когда-нибудь»"],
    [{}, "без времени"],
  ];
  for (const [view, expected] of cases) assert.equal(formatWhenForModel(view, timezone, now), expected);
  assert.equal(relativeDayLabel("2026-09-04", timezone, now), "сегодня");
});

test("the current time line is local and names today and tomorrow", () => {
  assert.equal(formatCurrentTimeLine(now, timezone), "2026-09-04 14:05 (пятница), timezone Europe/Kyiv; today=2026-09-04, tomorrow=2026-09-05");
  assert.equal(formatCurrentTimeLine(new Date("2026-12-31T23:30:00Z"), timezone), "2027-01-01 01:30 (пятница), timezone Europe/Kyiv; today=2027-01-01, tomorrow=2027-01-02");
});

test("beyond the limit, the nearest slots are shared between recent overdue and upcoming tasks", () => {
  const tasks = [];
  const occurrencesByTask = new Map();
  // 50 overdue tasks (hours ago) and 50 upcoming ones (hours ahead).
  for (let index = 0; index < 50; index += 1) {
    const past = `past-${String(index).padStart(2, "0")}`;
    const future = `future-${String(index).padStart(2, "0")}`;
    tasks.push(task(past), task(future));
    occurrencesByTask.set(past, [occurrence(past, { plannedStartAt: new Date(now.getTime() - (50 - index) * 3_600_000) })]);
    occurrencesByTask.set(future, [occurrence(future, { plannedStartAt: new Date(now.getTime() + (index + 1) * 3_600_000) })]);
  }
  const selection = selectTasksForContext(tasks, occurrencesByTask, new Set(), { now, timezone });
  assert.equal(selection.total, 100);
  assert.equal(selection.shown.length, 40);
  const shownIds = selection.shown.map((item) => item.id);
  // 10 most recently overdue, then the 30 soonest upcoming, still sorted by time.
  assert.deepEqual(
    shownIds.slice(0, 10),
    Array.from({ length: 10 }, (_, i) => `past-${String(40 + i).padStart(2, "0")}`),
  );
  assert.deepEqual(shownIds.slice(10, 13), ["future-00", "future-01", "future-02"]);
  assert.equal(shownIds.at(-1), "future-29");
});

test("an oversized context is trimmed in a fixed order: recent topics, long memory, then far tasks", () => {
  const tasks = Array.from({ length: 60 }, (_, i) => ({ id: `t${i + 1}`, title: `Задача ${i} ${"о".repeat(200)}`, when: "завтра 10:00" }));
  const model = {
    tasks,
    goals: [],
    settings: null,
    memory: Array.from({ length: 30 }, (_, i) => ({ id: `m${i + 1}`, type: "note", content: "м".repeat(2_000) })),
    topic: { active: null, recent: [{ title: "тема", summary: "с".repeat(2_000) }] },
  };
  const budgeted = budgetModelContext(model, 20_000);
  assert.ok(JSON.stringify(budgeted).length <= 20_000);
  assert.deepEqual(budgeted.topic.recent, []);
  assert.ok(budgeted.memory.every((item) => item.content.length <= 300));
  assert.ok(budgeted.tasks.length < 60 && budgeted.tasks.length >= 20);
  assert.match(budgeted.tasksNote, new RegExp(`Показаны ${budgeted.tasks.length} из 60`));
  assert.equal(budgetModelContext({ ...model, tasks: [], memory: [] }, 20_000).topic.recent.length, 1, "a context within budget is returned untouched");
});
