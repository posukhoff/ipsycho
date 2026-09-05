import { telegramLocale } from "../../telegram/telegram-locale.js";
import type { Locale, SettingsResponse } from "../contracts/index.js";
import type { WebSettingsRow } from "./web-auth-context.js";

/**
 * `user_settings` as the settings screen reads it.
 *
 * It lives here rather than in `src/api/settings/` because `GET /me` embeds the same shape, and two
 * mappings of one row is how the bootstrap call and the settings screen start disagreeing about
 * what the user configured. Group 3 imports this for `GET /settings` and `PATCH /settings`.
 *
 * Nothing is computed: every field is a column, re-grouped the way the screen is. The row's three
 * separate timezones and eight quiet-hours columns are exactly what made the bot's settings card
 * unreadable, and re-flattening them here would only move the problem into the client.
 */
export function presentSettings(row: WebSettingsRow, extras: { historyMessageCount: number }): SettingsResponse {
  return {
    version: row.version,
    timezone: row.timezone,
    digestTimezone: row.digestTimezone,
    pinnedLanguage: asLocale(row.pinnedLanguage),
    telegramLanguage: row.telegramLanguage,
    // The bot's rule, unchanged: a pinned language wins, else the one Telegram last reported.
    resolvedLocale: telegramLocale(row.pinnedLanguage, row.telegramLanguage ?? undefined),
    // The morning card has one reference time, and it is also what «утром» resolves to.
    morningDigest: { enabled: row.morningDigestEnabled, time: row.morningReferenceTime },
    eveningReferenceTime: row.eveningReferenceTime,
    weeklyReview: { enabled: row.weeklyReviewEnabled, weekday: row.weeklyReviewWeekday, time: row.weeklyReviewTime },
    quietHours: {
      enabled: row.quietHoursEnabled,
      weekdayStart: row.weekdayQuietStart,
      weekdayEnd: row.weekdayQuietEnd,
      weekendStart: row.weekendQuietStart,
      weekendEnd: row.weekendQuietEnd,
      timezone: row.quietHoursTimezone,
    },
    notificationsSnoozedUntil: row.notificationsSnoozedUntil?.toISOString() ?? null,
    reminderDefaults: {
      // A jsonb column: the row can legally hold anything, so it is narrowed the same way
      // `task-plan-rules.ts` narrows it rather than trusted into the response contract.
      eventOffsetsMinutes: Array.isArray(row.eventReminderOffsetsMinutes) ? row.eventReminderOffsetsMinutes.filter((value): value is number => Number.isInteger(value)) : [],
      plannedTaskOffsetMinutes: row.plannedTaskReminderOffsetMinutes,
      criticalPostDueMinutes: row.criticalPostDueMinutes,
    },
    // The `seen_*` columns: how long after a reminder an unanswered card escalates, by importance.
    escalationMinutes: { normal: row.seenNormalMinutes, required: row.seenRequiredMinutes, critical: row.seenCriticalMinutes },
    onboardingCompletedAt: row.onboardingCompletedAt?.toISOString() ?? null,
    historyMessageCount: extras.historyMessageCount,
  };
}

/** `pinned_language` is a varchar; only the three the interface has count as pinned. */
function asLocale(value: string | null): Locale | null {
  if (value === "ru" || value === "uk" || value === "en") return value;
  return null;
}
