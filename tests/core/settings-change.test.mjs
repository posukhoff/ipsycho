import test from "node:test";
import assert from "node:assert/strict";
import { buildSettingsPatch, DEFAULT_QUIET_HOURS } from "../../.core-dist/settings-change.js";

const current = { timezone: "Europe/Kyiv" };

test("one builder serves commands and the model: digest, weekly review and quiet hours carry the user's timezone", () => {
  assert.deepEqual(buildSettingsPatch({ operation: "digest", kind: "morning", enabled: true, time: "08:30" }, current), {
    morningDigestEnabled: true,
    digestTimezone: "Europe/Kyiv",
    morningReferenceTime: "08:30",
  });
  assert.deepEqual(buildSettingsPatch({ operation: "weekly_review", enabled: true, weekday: 7, time: "18:00" }, current), {
    weeklyReviewEnabled: true,
    digestTimezone: "Europe/Kyiv",
    weeklyReviewWeekday: 7,
    weeklyReviewTime: "18:00",
  });
  assert.deepEqual(buildSettingsPatch({ operation: "quiet_hours", enabled: true, ...DEFAULT_QUIET_HOURS }, current), {
    quietHoursEnabled: true,
    quietHoursTimezone: "Europe/Kyiv",
    weekdayQuietStart: "22:00",
    weekdayQuietEnd: "08:00",
    weekendQuietStart: "23:00",
    weekendQuietEnd: "09:00",
  });
  assert.deepEqual(buildSettingsPatch({ operation: "quiet_hours", enabled: false, weekdayStart: "01:00" }, current), {
    quietHoursEnabled: false,
    quietHoursTimezone: "Europe/Kyiv",
  });
});

test("timezone applies to digests and quiet hours only when asked; language normalizes; snooze stores the instant", () => {
  assert.deepEqual(buildSettingsPatch({ operation: "timezone", timezone: "Europe/Berlin", applyTo: "profile_only" }, current), { timezone: "Europe/Berlin" });
  assert.deepEqual(buildSettingsPatch({ operation: "timezone", timezone: "Europe/Berlin", applyTo: "all" }, current), {
    timezone: "Europe/Berlin",
    digestTimezone: "Europe/Berlin",
    quietHoursTimezone: "Europe/Berlin",
  });
  assert.deepEqual(buildSettingsPatch({ operation: "language", language: "EN-us" }, current), { pinnedLanguage: "en-US" });
  const until = new Date("2026-09-05T06:00:00Z");
  assert.deepEqual(buildSettingsPatch({ operation: "snooze", until }, current), { notificationsSnoozedUntil: until });
});

test("the rules are the same on both paths: HH:MM, weekday 1..7, 15-minute floors, non-empty defaults", () => {
  assert.throws(
    () => buildSettingsPatch({ operation: "digest", kind: "evening", enabled: true, time: "25:00" }, current),
    (error) => error.code === "time_invalid",
  );
  assert.throws(
    () => buildSettingsPatch({ operation: "weekly_review", enabled: true, weekday: 8, time: "10:00" }, current),
    (error) => error.code === "settings_shape",
  );
  assert.throws(
    () => buildSettingsPatch({ operation: "reminder_defaults", seenNormalMinutes: 10 }, current),
    (error) => error.code === "settings_shape",
  );
  assert.throws(
    () => buildSettingsPatch({ operation: "reminder_defaults" }, current),
    (error) => error.code === "settings_shape",
  );
  assert.throws(
    () => buildSettingsPatch({ operation: "timezone", timezone: "Mars/Olympus", applyTo: "all" }, current),
    (error) => error.code === "timezone",
  );
  assert.deepEqual(buildSettingsPatch({ operation: "reminder_defaults", eventOffsets: [0, -15, -15, -60] }, current), { eventReminderOffsetsMinutes: [-60, -15, 0] });
});
