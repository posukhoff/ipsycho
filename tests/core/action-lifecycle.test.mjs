import test from "node:test";
import assert from "node:assert/strict";
import { actionExpiry, canConfirmAction, canUndoAction } from "../../.core-dist/action-lifecycle.js";

test("pending confirmation expires deterministically", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const expires = actionExpiry(now, 1000);
  assert.equal(canConfirmAction("pending", expires, now), true);
  assert.equal(canConfirmAction("pending", expires, new Date("2026-08-09T12:00:01Z")), false);
});

test("undo requires applied status and future expiry", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const future = new Date("2026-08-09T13:00:00Z");
  assert.equal(canUndoAction("applied", future, now), true);
  assert.equal(canUndoAction("pending", future, now), false);
  assert.equal(canUndoAction("applied", null, now), false);
});
