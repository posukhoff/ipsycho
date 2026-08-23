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
