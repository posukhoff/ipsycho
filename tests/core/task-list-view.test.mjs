import test from "node:test";
import assert from "node:assert/strict";
import { compareGroups, filterByScope, groupLocalDates, groupTaskRows, normalizeGroupTitle, paginate, rowLocalDate, scopeCounts } from "../../.core-dist/task-list-view.js";

const TZ = "Europe/Kyiv";
const TODAY = "2026-09-05";

function row(title, { date = null, time = null, overdue = false, id = null, taskId = null, importance = "normal", recurrenceRule = null } = {}) {
  const occurrenceId = id ?? `occ-${title}-${date ?? "none"}-${time ?? "00:00"}`;
  const task = { id: taskId ?? `task-${title}-${date ?? "none"}`, title, importance, recurrenceRule, timezone: TZ, timeMode: time ? "point" : "window" };
  if (!date) return { task, occurrence: null };
  const occurrence = { id: occurrenceId, status: "open", timezone: TZ, overdue };
  if (time) occurrence.plannedStartAt = new Date(`${date}T${time}:00+03:00`);
  else occurrence.plannedLocalDate = date;
  return { task, occurrence };
}

test("three separate tasks with the same title collapse into one group", () => {
  const rows = [
    row("Позвонить маме", { date: "2026-09-06", time: "10:00", taskId: "a" }),
    row("позвонить  МАМЕ", { date: "2026-09-09", time: "12:00", taskId: "b" }),
    row("Позвонить маме ", { date: "2026-09-11", time: "18:00", taskId: "c" }),
  ];
  const groups = groupTaskRows(rows, TODAY);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rows.length, 3);
  assert.deepEqual(groupLocalDates(groups[0]), ["2026-09-06", "2026-09-09", "2026-09-11"]);
  assert.equal(groups[0].lead.task.id, "a");
  assert.equal(groups[0].key, groups[0].lead.occurrence.id);
});

test("a materialized series is one group and never consumes the page", () => {
  const series = Array.from({ length: 30 }, (_, index) =>
    row("Зарядка", { date: new Date(Date.UTC(2026, 8, 5 + index)).toISOString().slice(0, 10), time: "07:00", taskId: "series", recurrenceRule: "FREQ=DAILY" }),
  );
  const groups = groupTaskRows([...series, row("Оплатить налоги", { date: "2026-09-06", time: "12:00" })], TODAY);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((group) => group.title === "Зарядка").rows.length, 30);
  assert.equal(groups.find((group) => group.title === "Зарядка").recurrenceRule, "FREQ=DAILY");
});

test("two times of one task on the same day are one group with one date", () => {
  const groups = groupTaskRows([row("Таблетки", { date: TODAY, time: "10:00", taskId: "pill" }), row("Таблетки", { date: TODAY, time: "18:00", taskId: "pill" })], TODAY);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rows.length, 2);
  assert.deepEqual(groupLocalDates(groups[0]), [TODAY]);
});

test("scopes are windows of local days and always keep past work", () => {
  const rows = [
    row("Просроченное", { date: "2026-08-20", time: "09:00", overdue: true }),
    row("Тихо просроченное", { date: "2026-09-01", time: "09:00" }),
    row("Сегодня", { date: TODAY, time: "09:00" }),
    row("Граница недели", { date: "2026-09-12", time: "09:00" }),
    row("За неделей", { date: "2026-09-13", time: "09:00" }),
    row("Граница месяца", { date: "2026-10-06", time: "09:00" }),
    row("За месяцем", { date: "2026-10-07", time: "09:00" }),
    row("Без даты"),
  ];
  const titles = (scope) => filterByScope(rows, scope, TODAY).map(({ task }) => task.title);
  assert.deepEqual(titles("overdue"), ["Просроченное", "Тихо просроченное"]);
  assert.deepEqual(titles("today"), ["Просроченное", "Тихо просроченное", "Сегодня"]);
  assert.deepEqual(titles("week"), ["Просроченное", "Тихо просроченное", "Сегодня", "Граница недели"]);
  assert.deepEqual(titles("month"), ["Просроченное", "Тихо просроченное", "Сегодня", "Граница недели", "За неделей", "Граница месяца"]);
  assert.deepEqual(titles("nodate"), ["Без даты"]);
  assert.equal(titles("all").length, 8);
  assert.equal(scopeCounts(rows, TODAY).week, 4);
});

test("a critical task a month away sorts below today's work", () => {
  const far = row("Критичное через месяц", { date: "2026-10-05", time: "09:00", importance: "critical" });
  const near = row("Обычное сегодня", { date: TODAY, time: "15:00" });
  const late = row("Просроченное", { date: "2026-09-02", time: "09:00", overdue: true });
  const groups = groupTaskRows([far, near, late], TODAY);
  assert.deepEqual(
    groups.map((group) => group.title),
    ["Просроченное", "Обычное сегодня", "Критичное через месяц"],
  );
});

test("importance still breaks ties inside one day", () => {
  const groups = groupTaskRows([row("Обычное", { date: TODAY, time: "09:00" }), row("Критичное", { date: TODAY, time: "09:00", importance: "critical" })], TODAY);
  assert.deepEqual(
    groups.map((group) => group.title),
    ["Критичное", "Обычное"],
  );
  assert.equal(compareGroups(groups[0], groups[1], TODAY) < 0, true);
});

test("a group of only past rows leads with the most recent one", () => {
  const groups = groupTaskRows(
    [row("Отчёт", { date: "2026-08-20", time: "09:00", overdue: true, taskId: "r" }), row("Отчёт", { date: "2026-09-02", time: "09:00", overdue: true, taskId: "r" })],
    TODAY,
  );
  assert.equal(rowLocalDate(groups[0].lead), "2026-09-02");
  assert.equal(groups[0].pastCount, 2);
});

test("normalizeGroupTitle and paginate behave at the edges", () => {
  assert.equal(normalizeGroupTitle("  Купить хлеб  "), "купить хлеб");
  assert.equal(normalizeGroupTitle("Купить   хлеб"), "купить хлеб");
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 1, 2), { items: [3, 4], page: 1, pages: 3, rest: 1 });
  assert.deepEqual(paginate([1, 2, 3], 9, 2), { items: [3], page: 1, pages: 2, rest: 0 });
  assert.deepEqual(paginate([], 0, 8), { items: [], page: 0, pages: 1, rest: 0 });
});
