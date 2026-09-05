import { DomainRuleError } from "./errors.js";
import { normalizeLanguageTag } from "./language.js";
import { parseLocalTime } from "./timezone.js";

/**
 * Every way settings can change, from a command, a button or the model, expressed once.
 * `buildSettingsPatch` validates and produces the column patch; the two write paths (the
 * deterministic SettingsService and the journaled settings action) used to keep separate
 * copies of this logic and had already drifted apart.
 */
export type SettingsChange =
  | { operation: "timezone"; timezone: string; applyTo: "profile_only" | "all" }
  | { operation: "language"; language: string | null }
  | { operation: "digest"; kind: "morning"; enabled: boolean; time?: string | null }
  | { operation: "digest_preset"; enabled: boolean }
  | { operation: "weekly_review"; enabled: boolean; weekday?: number | null; time?: string | null }
  | { operation: "weekly_preset"; enabled: boolean }
  | { operation: "quiet_hours"; enabled: boolean; weekdayStart?: string | null; weekdayEnd?: string | null; weekendStart?: string | null; weekendEnd?: string | null }
  | { operation: "snooze"; until: Date | null }
  | {
      operation: "reminder_defaults";
      eventOffsets?: number[] | null;
      plannedTaskOffsetMinutes?: number | null;
      criticalPostDueMinutes?: number | null;
      seenNormalMinutes?: number | null;
      seenRequiredMinutes?: number | null;
      seenCriticalMinutes?: number | null;
    };

export interface SettingsPatchFields {
  timezone?: string;
  digestTimezone?: string;
  quietHoursTimezone?: string;
  pinnedLanguage?: string | null;
  quietHoursEnabled?: boolean;
  weekdayQuietStart?: string;
  weekdayQuietEnd?: string;
  weekendQuietStart?: string;
  weekendQuietEnd?: string;
  notificationsSnoozedUntil?: Date | null;
  morningReferenceTime?: string;
  eveningReferenceTime?: string;
  morningDigestEnabled?: boolean;
  weeklyReviewEnabled?: boolean;
  weeklyReviewWeekday?: number;
  weeklyReviewTime?: string;
  eventReminderOffsetsMinutes?: number[];
  plannedTaskReminderOffsetMinutes?: number;
  criticalPostDueMinutes?: number;
  seenNormalMinutes?: number;
  seenRequiredMinutes?: number;
  seenCriticalMinutes?: number;
}

export const DEFAULT_QUIET_HOURS = { weekdayStart: "22:00", weekdayEnd: "08:00", weekendStart: "23:00", weekendEnd: "09:00" } as const;
export const DEFAULT_DIGEST_TIMES = { morning: "09:00" } as const;
export const DEFAULT_WEEKLY_REVIEW = { weekday: 7, time: "20:00" } as const;

function time(value: string | null | undefined, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    parseLocalTime(value);
  } catch {
    throw new DomainRuleError(`${field} must be a HH:MM time`, "time_invalid");
  }
  return value;
}

function atLeast15(value: number | null | undefined, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 15) throw new DomainRuleError(`${field} must be an integer of at least 15 minutes`, "settings_shape");
  return value;
}

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function buildSettingsPatch(change: SettingsChange, current: { timezone: string }): SettingsPatchFields {
  switch (change.operation) {
    case "timezone": {
      if (!isIanaTimezone(change.timezone)) throw new DomainRuleError("timezone is not a valid IANA timezone", "timezone");
      const all = change.applyTo === "all";
      return { timezone: change.timezone, ...(all ? { digestTimezone: change.timezone, quietHoursTimezone: change.timezone } : {}) };
    }
    case "language":
      return { pinnedLanguage: change.language === null ? null : normalizeLanguageTag(change.language) };
    case "digest": {
      const reference = time(change.time, "digest time");
      return { morningDigestEnabled: change.enabled, digestTimezone: current.timezone, ...(reference ? { morningReferenceTime: reference } : {}) };
    }
    case "digest_preset":
      return {
        morningDigestEnabled: change.enabled,
        morningReferenceTime: DEFAULT_DIGEST_TIMES.morning,
        digestTimezone: current.timezone,
      };
    case "weekly_review": {
      if (change.weekday !== null && change.weekday !== undefined && (!Number.isInteger(change.weekday) || change.weekday < 1 || change.weekday > 7))
        throw new DomainRuleError("weekday must be 1..7", "settings_shape");
      const reference = time(change.time, "weekly review time");
      return {
        weeklyReviewEnabled: change.enabled,
        digestTimezone: current.timezone,
        ...(change.weekday !== null && change.weekday !== undefined ? { weeklyReviewWeekday: change.weekday } : {}),
        ...(reference ? { weeklyReviewTime: reference } : {}),
      };
    }
    case "weekly_preset":
      return {
        weeklyReviewEnabled: change.enabled,
        weeklyReviewWeekday: DEFAULT_WEEKLY_REVIEW.weekday,
        weeklyReviewTime: DEFAULT_WEEKLY_REVIEW.time,
        digestTimezone: current.timezone,
      };
    case "quiet_hours": {
      const patch: SettingsPatchFields = { quietHoursEnabled: change.enabled, quietHoursTimezone: current.timezone };
      if (!change.enabled) return patch;
      const weekdayStart = time(change.weekdayStart, "quiet hours weekday start");
      const weekdayEnd = time(change.weekdayEnd, "quiet hours weekday end");
      // «Не пиши мне с 23:00 до 8 утра» names one range. Demanding a separate weekend range turned
      // that into a refusal; the weekend simply follows the weekday range unless the user split them.
      const weekendStart = time(change.weekendStart, "quiet hours weekend start") ?? weekdayStart;
      const weekendEnd = time(change.weekendEnd, "quiet hours weekend end") ?? weekdayEnd;
      return {
        ...patch,
        ...(weekdayStart ? { weekdayQuietStart: weekdayStart } : {}),
        ...(weekdayEnd ? { weekdayQuietEnd: weekdayEnd } : {}),
        ...(weekendStart ? { weekendQuietStart: weekendStart } : {}),
        ...(weekendEnd ? { weekendQuietEnd: weekendEnd } : {}),
      };
    }
    case "snooze":
      return { notificationsSnoozedUntil: change.until };
    case "reminder_defaults": {
      if (change.eventOffsets !== null && change.eventOffsets !== undefined) {
        if (!change.eventOffsets.length || change.eventOffsets.some((value) => !Number.isInteger(value)))
          throw new DomainRuleError("event offsets must be integer minutes", "settings_shape");
      }
      if (change.plannedTaskOffsetMinutes !== null && change.plannedTaskOffsetMinutes !== undefined && !Number.isInteger(change.plannedTaskOffsetMinutes)) {
        throw new DomainRuleError("plannedTaskOffsetMinutes must be integer minutes", "settings_shape");
      }
      const critical = atLeast15(change.criticalPostDueMinutes, "criticalPostDueMinutes");
      const seenNormal = atLeast15(change.seenNormalMinutes, "seenNormalMinutes");
      const seenRequired = atLeast15(change.seenRequiredMinutes, "seenRequiredMinutes");
      const seenCritical = atLeast15(change.seenCriticalMinutes, "seenCriticalMinutes");
      const offsets = change.eventOffsets ? [...new Set(change.eventOffsets)].sort((a, b) => a - b) : undefined;
      const patch: SettingsPatchFields = {
        ...(offsets ? { eventReminderOffsetsMinutes: offsets } : {}),
        ...(change.plannedTaskOffsetMinutes !== null && change.plannedTaskOffsetMinutes !== undefined ? { plannedTaskReminderOffsetMinutes: change.plannedTaskOffsetMinutes } : {}),
        ...(critical !== undefined ? { criticalPostDueMinutes: critical } : {}),
        ...(seenNormal !== undefined ? { seenNormalMinutes: seenNormal } : {}),
        ...(seenRequired !== undefined ? { seenRequiredMinutes: seenRequired } : {}),
        ...(seenCritical !== undefined ? { seenCriticalMinutes: seenCritical } : {}),
      };
      if (!Object.keys(patch).length) throw new DomainRuleError("at least one reminder default is required", "settings_shape");
      return patch;
    }
  }
}
