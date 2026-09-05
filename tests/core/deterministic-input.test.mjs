import test from "node:test";
import assert from "node:assert/strict";
import { parseRescheduleInput } from "../../.core-dist/deterministic-input.js";

const TZ = "Europe/Kyiv";

test("deterministic point reschedule parses an optional reason", () => {
  const result = parseRescheduleInput("2026-08-12 18:30 | не успеваю раньше", "point", TZ);
  assert.equal(result.reason, "не успеваю раньше");
  assert.equal(result.schedule.plannedStartAt.toISOString(), "2026-08-12T15:30:00.000Z");
});

test("deterministic window may cross midnight", () => {
  const result = parseRescheduleInput("2026-08-12 23:00-01:00", "window", TZ);
  assert.ok(result.schedule.plannedEndAt > result.schedule.plannedStartAt);
});

test("deadline accepts date-only without inventing a clock time", () => {
  const result = parseRescheduleInput("2026-08-15", "deadline", TZ);
  assert.equal(result.schedule.dueLocalDate, "2026-08-15");
  assert.equal(result.schedule.dueAt, undefined);
});

test("fuzzy reschedule preserves horizon plus explicit review checkpoint", () => {
  const result = parseRescheduleInput("примерно: в течение осени @ 2026-09-01 10:00", "point", TZ);
  assert.equal(result.schedule.fuzzyHorizonText, "в течение осени");
  assert.equal(result.schedule.reviewAt.toISOString(), "2026-09-01T07:00:00.000Z");
});
