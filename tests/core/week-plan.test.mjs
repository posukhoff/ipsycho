import test from "node:test";
import assert from "node:assert/strict";
import { comparePoolRows, currentWeekStart, isPickLive, isPickStale, localWeekday, mondayOf, previousWeekRange, WEEK_PICK_LIMIT } from "../../.core-dist/week-plan.js";

test("the week starts on Monday, in local dates, across month and year ends", () => {
  assert.equal(localWeekday("2026-09-07"), 1);
  assert.equal(localWeekday("2026-09-13"), 7);
  assert.equal(mondayOf("2026-09-07"), "2026-09-07");
  assert.equal(mondayOf("2026-09-13"), "2026-09-07");
  // A week that spans a month boundary and one that spans a year boundary.
  assert.equal(mondayOf("2026-10-01"), "2026-09-28");
  assert.equal(mondayOf("2027-01-01"), "2026-12-28");
});

test("a pick counts only for the week it names, and an older one reads as taken and not done", () => {
  const today = "2026-09-09";
  assert.equal(currentWeekStart(today), "2026-09-07");
  assert.equal(isPickLive("2026-09-07", today), true);
  assert.equal(isPickLive("2026-08-31", today), false);
  assert.equal(isPickLive(null, today), false);
  assert.equal(isPickStale("2026-08-31", today), true);
  assert.equal(isPickStale("2026-09-07", today), false);
  // A mark for a future week is neither live nor stale: nothing writes one, and if something did,
  // it must not silently count as this week's plan.
  assert.equal(isPickLive("2026-09-14", today), false);
  assert.equal(isPickStale("2026-09-14", today), false);
});

test("the week boundary is a local date, so a spring-forward week is still seven days", () => {
  // Europe/Kyiv moves the clock on 2026-03-29; the local dates do not care.
  assert.equal(mondayOf("2026-03-29"), "2026-03-23");
  assert.deepEqual(previousWeekRange("2026-03-30"), { start: "2026-03-23", end: "2026-03-29" });
  assert.deepEqual(previousWeekRange("2026-01-04"), { start: "2025-12-22", end: "2025-12-28" });
});

test("the pick screen leads with what was taken and left undone", () => {
  const today = "2026-09-09";
  const rows = [
    { id: "fresh-normal", pickedWeekStart: null, importance: "normal", updatedAt: "2026-09-08T10:00:00Z" },
    { id: "taken-now", pickedWeekStart: "2026-09-07", importance: "normal", updatedAt: "2026-09-01T10:00:00Z" },
    { id: "left-over", pickedWeekStart: "2026-08-31", importance: "normal", updatedAt: "2026-08-20T10:00:00Z" },
    { id: "fresh-critical", pickedWeekStart: null, importance: "critical", updatedAt: "2026-09-02T10:00:00Z" },
  ];
  assert.deepEqual(
    [...rows].sort(comparePoolRows(today)).map((row) => row.id),
    ["left-over", "taken-now", "fresh-critical", "fresh-normal"],
  );
  assert.equal(WEEK_PICK_LIMIT, 7);
});
