import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../../dist/ai/ai.service.js";

test("AI prompt protects user autonomy and prevents needless clarification", () => {
  const prompt = buildSystemPrompt("Europe/Kyiv", new Date("2026-08-11T12:00:00.000Z"));
  assert.match(prompt, /Treat the user as competent/);
  assert.match(prompt, /Never ask for information already available/);
  assert.match(prompt, /‘делай’, ‘сам реши’/);
  assert.match(prompt, /materially changes a safe action/);
  assert.match(prompt, /treat the turn as discovery, not a mutation request/);
  assert.match(prompt, /at most three provisional next steps/);
  assert.match(prompt, /Return actions=\[\] until the user explicitly asks/);
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

test("AI prompt requires structured local schedules and recurrence", () => {
  const prompt = buildSystemPrompt("Europe/Kyiv", new Date("2026-08-11T12:00:00.000Z"));
  assert.match(prompt, /localSchedule=\{mode,timezone,startDate,startTime/);
  assert.match(prompt, /recurrence=\{frequency,interval,startsOn,endsOn/);
  assert.match(prompt, /Do not generate them in a new action/);
});

test("AI prompt offers concrete and fuzzy choices with proposed times for broad day parts", () => {
  const prompt = buildSystemPrompt("Europe/Kyiv", new Date("2026-08-23T06:00:00.000Z"), "ru", {
    settings: {
      morningDigest: { enabled: false, time: "09:00" },
      eveningDigest: { enabled: false, time: "18:00" },
    },
  });

  assert.match(prompt, /choice between a concrete schedule and a fuzzy horizon/);
  assert.match(prompt, /State the date and time for both options/);
  assert.match(prompt, /do not merely ask the user to supply a time/);
  assert.match(prompt, /even when that digest is disabled/);
  assert.match(prompt, /Return actions=\[\] until the user chooses/);
  assert.match(prompt, /"eveningDigest":\{"enabled":false,"time":"18:00"\}/);
});

test("AI prompt binds the reply to the returned actions and supports reminders on new tasks", () => {
  // Production 2026-08-23: the model promised a 17:30 reminder while create_task carried only the default one,
  // then renamed the wrong task after "как ты предложил".
  const prompt = buildSystemPrompt("Europe/Kyiv", new Date("2026-08-23T07:00:00.000Z"));
  assert.match(prompt, /create_task\.reminder/);
  assert.match(prompt, /A reminder that is not in an action does not exist/);
  assert.match(prompt, /Never claim that a reminder, time, title, or other change was set unless the same response contains the action/);
  assert.match(prompt, /‘как ты предложил’/);
  assert.match(prompt, /against the same listed task you proposed it for/);
  assert.match(prompt, /for example yearly/);
});
