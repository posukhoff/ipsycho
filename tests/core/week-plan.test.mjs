import test from "node:test";
import assert from "node:assert/strict";
import { comparePoolRows, isPickLive, isPickStale, localWeekday, mondayOf, previousWeekRange, targetWeekStart, WEEK_PICK_LIMIT } from "../../.core-dist/week-plan.js";

test("the week starts on Monday, in local dates, across month and year ends", () => {
  assert.equal(localWeekday("2026-09-07"), 1);
  assert.equal(localWeekday("2026-09-13"), 7);
  assert.equal(mondayOf("2026-09-07"), "2026-09-07");
  assert.equal(mondayOf("2026-09-13"), "2026-09-07");
  // A week that spans a month boundary and one that spans a year boundary.
  assert.equal(mondayOf("2026-10-01"), "2026-09-28");
  assert.equal(mondayOf("2027-01-01"), "2026-12-28");
});

test("a pick made on the day the week card arrives is for the week that starts tomorrow", () => {
  // The weekly card defaults to Sunday evening and invites the user to fill the coming week. Stamping
  // today's Monday made every Sunday pick read as last week's unfinished work the moment Monday came.
  assert.equal(targetWeekStart("2026-09-06"), "2026-09-07");
  assert.equal(targetWeekStart("2026-09-07"), "2026-09-07");
  assert.equal(targetWeekStart("2026-09-12"), "2026-09-07");
  const sundayPick = targetWeekStart("2026-09-06");
  for (const day of ["2026-09-06", "2026-09-07", "2026-09-09", "2026-09-12"]) {
    assert.equal(isPickLive(sundayPick, day), true, `pick must still count on ${day}`);
  }
});

test("a pick counts only for the week it was made for, and last week's reads as taken and not done", () => {
  const today = "2026-09-09";
  assert.equal(isPickLive("2026-09-07", today), true);
  assert.equal(isPickLive("2026-08-31", today), false);
  assert.equal(isPickLive(null, today), false);
  assert.equal(isPickStale("2026-08-31", today), true);
  assert.equal(isPickStale("2026-09-07", today), false);
  // Older than one week is no longer news: the row goes back to being an ordinary pool task.
  assert.equal(isPickStale("2026-08-24", today), false);
  assert.equal(isPickLive("2026-08-24", today), false);
});

test("the week boundary is a local date, so a spring-forward week is still seven days", () => {
  // Europe/Kyiv moves the clock on 2026-03-29; the local dates do not care.
  assert.equal(mondayOf("2026-03-29"), "2026-03-23");
  assert.deepEqual(previousWeekRange("2026-03-30"), { start: "2026-03-23", end: "2026-03-29" });
  // On Sunday the week that just ended is the one containing today.
  assert.deepEqual(previousWeekRange("2026-09-06"), { start: "2026-08-31", end: "2026-09-06" });
  // 4 January 2026 is a Sunday, so the week that just ended is the one it closes.
  assert.deepEqual(previousWeekRange("2026-01-04"), { start: "2025-12-29", end: "2026-01-04" });
});

test("the pick screen leads with last week's leftovers and never re-sorts when a row is picked", () => {
  const today = "2026-09-09";
  const rows = [
    { id: "b-normal", title: "Б", pickedWeekStart: null, importance: "normal" },
    { id: "a-normal", title: "А", pickedWeekStart: null, importance: "normal" },
    { id: "left-over", title: "Я", pickedWeekStart: "2026-08-31", importance: "normal" },
    { id: "critical", title: "Ю", pickedWeekStart: null, importance: "critical" },
  ];
  assert.deepEqual(
    [...rows].sort(comparePoolRows(today)).map((row) => row.id),
    ["left-over", "critical", "a-normal", "b-normal"],
  );
  // Picking a row must not move it: the screen redraws after every tap.
  const picked = rows.map((row) => (row.id === "a-normal" ? { ...row, pickedWeekStart: "2026-09-07" } : row));
  assert.deepEqual(
    [...picked].sort(comparePoolRows(today)).map((row) => row.id),
    ["left-over", "critical", "a-normal", "b-normal"],
  );
  assert.equal(WEEK_PICK_LIMIT, 7);
});

test("a task whose day has passed leads the pool, ahead of last week's untaken pick", () => {
  const today = "2026-09-09";
  const rows = [
    { title: "Обычная", importance: "critical", pickedWeekStart: null },
    { title: "Взято и не начато", importance: "critical", pickedWeekStart: "2026-08-31" },
    { title: "Просрочено", importance: "normal", pickedWeekStart: null, overdue: true },
  ];
  assert.deepEqual(
    [...rows].sort(comparePoolRows(today)).map((row) => row.title),
    ["Просрочено", "Взято и не начато", "Обычная"],
    "importance never outranks a day that has already passed",
  );
});
