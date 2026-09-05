import test from "node:test";
import assert from "node:assert/strict";
import { TasksService, withExplicitReminder } from "../../dist/tasks/tasks.service.js";

const task = (id, overrides = {}) => ({
  id,
  title: id,
  recurrenceRule: null,
  importance: "normal",
  timeMode: "point",
  timezone: "Europe/Kyiv",
  reviewAt: null,
  ...overrides,
});

test("Today includes fuzzy tasks whose planning review falls on the requested local date", async () => {
  const repository = {
    listActionableForTelegram: async () => [
      {
        task: task("exact-today"),
        occurrence: {
          id: "occ-exact-today",
          status: "open",
          timezone: "Europe/Kyiv",
          plannedStartAt: new Date("2026-08-23T16:00:00Z"),
          plannedEndAt: null,
          plannedLocalDate: null,
          dueAt: null,
          dueLocalDate: null,
          overdue: false,
        },
      },
    ],
    listFuzzyReviewsForLocalDate: async (_workspaceId, localDate) =>
      localDate === "2026-08-23" ? [task("fuzzy-today", { timeMode: "fuzzy", fuzzyHorizonText: "сегодня вечером", reviewAt: new Date("2026-08-23T15:00:00Z") })] : [],
  };
  const service = new TasksService(repository, {}, {});

  const { groups, staleCount } = await service.listTodayGroupedForTelegram("workspace", "2026-08-23");

  assert.deepEqual(
    groups.map((group) => group.lead.task.id),
    ["exact-today", "fuzzy-today"],
  );
  assert.equal(groups[1].lead.occurrence, null);
  assert.equal(staleCount, 0);
});

const occurrenceOn = (id, iso, overdue = false) => ({
  id,
  status: "open",
  timezone: "Europe/Kyiv",
  plannedStartAt: new Date(iso),
  plannedEndAt: null,
  plannedLocalDate: null,
  dueAt: null,
  dueLocalDate: null,
  overdue,
});

test("Today lists the day itself and only counts what was left unclosed before it", async () => {
  const repository = {
    listActionableForTelegram: async () => [
      { task: task("today-late", { title: "Отчёт" }), occurrence: occurrenceOn("o1", "2026-08-23T06:00:00Z", true) },
      { task: task("last-week", { title: "Старое" }), occurrence: occurrenceOn("o2", "2026-08-14T06:00:00Z", true) },
      { task: task("tomorrow", { title: "Завтрашнее" }), occurrence: occurrenceOn("o3", "2026-08-24T06:00:00Z") },
    ],
    listFuzzyReviewsForLocalDate: async () => [],
  };
  const service = new TasksService(repository, {}, {});

  const { groups, staleCount } = await service.listTodayGroupedForTelegram("workspace", "2026-08-23");

  assert.deepEqual(
    groups.map((group) => group.title),
    ["Отчёт"],
  );
  assert.equal(staleCount, 1);
});

test("the task list collapses same-titled rows and every filter reports its own count", async () => {
  const repository = {
    listActionableForTelegram: async () => [
      { task: task("call-1", { title: "Позвонить маме" }), occurrence: occurrenceOn("c1", "2026-08-24T06:00:00Z") },
      { task: task("call-2", { title: "позвонить  МАМЕ" }), occurrence: occurrenceOn("c2", "2026-08-27T06:00:00Z") },
      { task: task("call-3", { title: "Позвонить маме" }), occurrence: occurrenceOn("c3", "2026-09-20T06:00:00Z") },
      { task: task("late", { title: "Старое" }), occurrence: occurrenceOn("l1", "2026-08-14T06:00:00Z", true) },
    ],
    listFuzzyForTelegram: async () => [task("someday", { title: "Гараж", timeMode: "fuzzy", fuzzyHorizonText: "на неделе" })],
    listPausedSeriesForTelegram: async () => [task("paused", { title: "Зарядка", recurrenceRule: "FREQ=WEEKLY" })],
    countPausedSeries: async () => 1,
  };
  const service = new TasksService(repository, {}, {});

  const week = await service.listGroupedForTelegram("workspace", { scope: "week", localDate: "2026-08-23" });

  assert.deepEqual(
    week.groups.map((group) => group.title),
    ["Старое", "Позвонить маме"],
  );
  assert.equal(week.groups[1].rows.length, 2, "the September call is outside the week window");
  assert.deepEqual(week.counts, { overdue: 1, today: 1, week: 2, month: 2, all: 3, nodate: 1 });
  // A paused series is in no window; the screen offers it as its own list instead of hiding it.
  assert.equal(week.pausedCount, 1);

  const all = await service.listGroupedForTelegram("workspace", { scope: "all", localDate: "2026-08-23" });
  assert.equal(all.groups.find((group) => group.title === "Позвонить маме").rows.length, 3);
});

test("an explicit reminder replaces the default user reminder but keeps follow-up rules", () => {
  const defaults = [
    { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: 0, purpose: "user_reminder", quietPolicy: "respect", origin: "default" },
    { triggerKind: "relative_timestamp", anchor: "due_at", offsetSeconds: 3600, purpose: "follow_up", quietPolicy: "respect", origin: "default" },
  ];
  const explicit = { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -1800, purpose: "user_reminder", quietPolicy: "respect", origin: "explicit" };
  assert.deepEqual(withExplicitReminder(defaults, explicit), [defaults[1], explicit]);
  assert.deepEqual(withExplicitReminder(defaults, undefined), defaults);
});
