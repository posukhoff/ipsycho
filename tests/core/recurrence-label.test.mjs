import test from "node:test";
import assert from "node:assert/strict";
import { recurrenceLabel } from "../../.core-dist/recurrence-label.js";

test("stored RRULEs read as plain Russian instead of a bare 🔁 icon", () => {
  assert.equal(recurrenceLabel("FREQ=DAILY;INTERVAL=1"), "каждый день");
  assert.equal(recurrenceLabel("FREQ=DAILY;INTERVAL=3"), "каждые 3 дня");
  assert.equal(recurrenceLabel("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR"), "каждую неделю: пн, ср, пт");
  assert.equal(recurrenceLabel("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU"), "каждые 2 недели: вт");
  assert.equal(recurrenceLabel("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1,15"), "каждый месяц, 1-го, 15-го");
  assert.equal(recurrenceLabel("FREQ=MONTHLY;INTERVAL=1", "2026-12-31"), "каждый месяц до 31.12.2026");
  assert.equal(recurrenceLabel(null), null);
  assert.equal(recurrenceLabel("FREQ=YEARLY"), null);
});

test("the rhythm names the dates the series skips, so the label is not a series the user lacks", () => {
  assert.equal(recurrenceLabel("FREQ=WEEKLY;INTERVAL=1;BYDAY=TU", null, "ru", ["2026-09-08"]), "каждую неделю: вт, кроме 08.09");
  assert.equal(recurrenceLabel("FREQ=DAILY;INTERVAL=1", "2026-09-30", "ru", ["2026-09-10", "2026-09-11"]), "каждый день до 30.09.2026, кроме 10.09, 11.09");
  // Four or more would take over the line, so the rest is a count.
  assert.equal(
    recurrenceLabel("FREQ=DAILY;INTERVAL=1", null, "en", ["2026-09-12", "2026-09-10", "2026-09-11", "2026-09-13", "2026-09-14"]),
    "every day, except 10.09, 11.09, 12.09 +2",
  );
  assert.equal(recurrenceLabel("FREQ=DAILY;INTERVAL=1", null, "uk", ["2026-09-10"]), "щодня, крім 10.09");
  assert.equal(recurrenceLabel("FREQ=DAILY;INTERVAL=1", null, "ru", []), "каждый день");
});
