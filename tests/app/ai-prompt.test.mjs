import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../../dist/ai/ai.service.js";

test("AI prompt protects user autonomy and prevents needless clarification", () => {
  const prompt = buildSystemPrompt("Europe/Kyiv", new Date("2026-08-11T12:00:00.000Z"));
  assert.match(prompt, /Treat the user as competent/);
  assert.match(prompt, /Never ask for information already available/);
  assert.match(prompt, /‘делай’, ‘сам реши’/);
  assert.match(prompt, /materially changes a safe action/);
});

test("AI prompt keeps repeated deferral support practical and non-clinical", () => {
  const prompt = buildSystemPrompt("Europe/Kyiv", new Date("2026-08-11T12:00:00.000Z"));
  assert.match(prompt, /First help with the work itself/);
  assert.match(prompt, /repeatedly deferred, ignored, or rescheduled/);
  assert.match(prompt, /Present it as an experiment/);
  assert.match(prompt, /Do not diagnose, label personality/);
});

test("AI prompt forbids system-data access and makes sensitive profile facts unavailable", () => {
  const prompt = buildSystemPrompt("Europe/Kyiv", new Date("2026-08-11T12:00:00.000Z"));
  assert.match(prompt, /no access to SQL, the database, server filesystem/);
  assert.match(prompt, /Never reveal, enumerate, compare, export, or search users/);
  assert.match(prompt, /Sensitive profile records are deliberately withheld/);
  assert.match(prompt, /return actions=\[\]/);
});
