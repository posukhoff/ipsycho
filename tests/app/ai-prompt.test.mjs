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

test("AI prompt exposes the full user settings surface without operator privileges", () => {
  const prompt = buildSystemPrompt("Europe/Kyiv", new Date("2026-08-11T12:00:00.000Z"));
  assert.match(prompt, /Use update_settings/);
  assert.match(prompt, /morning\/evening digests/);
  assert.match(prompt, /quiet hours/);
  assert.match(prompt, /reminder defaults/);
  assert.match(prompt, /Do not claim to change operator configuration/);
});

test("AI prompt exposes task-card lifecycle operations with series scope safety", () => {
  const prompt = buildSystemPrompt("Europe/Kyiv", new Date("2026-08-11T12:00:00.000Z"));
  assert.match(prompt, /Use update_occurrence/);
  assert.match(prompt, /start, skip one recurring occurrence, cancel one occurrence, seen/);
  assert.match(prompt, /unclear whether they mean this occurrence or the whole series/);
});

test("AI prompt does not require an existing task ID when creating a new task", () => {
  const prompt = buildSystemPrompt("Europe/Kyiv", new Date("2026-08-11T12:00:00.000Z"));
  assert.match(prompt, /Creating a new task never requires an existing task ID/);
  assert.match(prompt, /never claim that creation is blocked/);
});
