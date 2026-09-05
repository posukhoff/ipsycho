import test from "node:test";
import assert from "node:assert/strict";
import { TasksService, withExplicitReminder } from "../../dist/tasks/tasks.service.js";

const task = (id, overrides = {}) => ({
  id,
  title: id,
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

test("an explicit reminder replaces the default user reminder but keeps follow-up rules", () => {
  const defaults = [
    { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: 0, purpose: "user_reminder", quietPolicy: "respect", origin: "default" },
    { triggerKind: "relative_timestamp", anchor: "due_at", offsetSeconds: 3600, purpose: "follow_up", quietPolicy: "respect", origin: "default" },
  ];
  const explicit = { triggerKind: "relative_timestamp", anchor: "planned_start", offsetSeconds: -1800, purpose: "user_reminder", quietPolicy: "respect", origin: "explicit" };
  assert.deepEqual(withExplicitReminder(defaults, explicit), [defaults[1], explicit]);
  assert.deepEqual(withExplicitReminder(defaults, undefined), defaults);
});
