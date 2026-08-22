import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { localDateAndTimeToUtc, localDateAt, parseLocalTime, shiftLocalDate } from "../core/timezone.js";
import { normalizeLanguageTag } from "../core/language.js";
import { DatabaseService } from "../database/database.service.js";
import { userSettings } from "../database/schema.js";


export type PendingInput =
  | { kind: "reschedule"; occurrenceId: string }
  | { kind: "quick_reschedule_reason"; occurrenceId: string; choice: "1h" | "evening" | "tomorrow" }
  | { kind: "blocker"; occurrenceId: string }
  | { kind: "follow_up_custom"; occurrenceId: string; mode: "seen" | "result" };

export interface QuietHoursUpdate {
  enabled: boolean;
  weekdayStart?: string;
  weekdayEnd?: string;
  weekendStart?: string;
  weekendEnd?: string;
}

@Injectable()
export class SettingsService {
  constructor(private readonly database: DatabaseService) {}

  async get(userId: string) {
    const [row] = await this.database.db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
    return row ?? null;
  }

  async completeOnboarding(userId: string, now = new Date()): Promise<void> {
    await this.database.db.update(userSettings).set({ onboardingCompletedAt: now }).where(eq(userSettings.userId, userId));
  }

  async setDigestPreset(userId: string, enabled: boolean): Promise<void> {
    const current = await this.get(userId);
    if (!current) throw new Error("settings missing");
    await this.database.db.update(userSettings).set({
      morningDigestEnabled: enabled,
      eveningDigestEnabled: enabled,
      morningReferenceTime: "09:00",
      eveningReferenceTime: "20:00",
      digestTimezone: current.timezone,
    }).where(eq(userSettings.userId, userId));
  }

  async setWeeklyPreset(userId: string, enabled: boolean): Promise<void> {
    const current = await this.get(userId);
    if (!current) throw new Error("settings missing");
    await this.database.db.update(userSettings).set({
      weeklyReviewEnabled: enabled,
      weeklyReviewWeekday: 7,
      weeklyReviewTime: "20:00",
      digestTimezone: current.timezone,
    }).where(eq(userSettings.userId, userId));
  }

  async setQuietHours(userId: string, update: QuietHoursUpdate): Promise<void> {
    const values: Partial<typeof userSettings.$inferInsert> = { quietHoursEnabled: update.enabled };
    if (update.enabled) {
      for (const value of [update.weekdayStart, update.weekdayEnd, update.weekendStart, update.weekendEnd]) {
        if (value) parseLocalTime(value);
      }
      if (update.weekdayStart) values.weekdayQuietStart = update.weekdayStart;
      if (update.weekdayEnd) values.weekdayQuietEnd = update.weekdayEnd;
      if (update.weekendStart) values.weekendQuietStart = update.weekendStart;
      if (update.weekendEnd) values.weekendQuietEnd = update.weekendEnd;
    }
    const current = await this.get(userId);
    if (!current) throw new Error("settings missing");
    values.quietHoursTimezone = current.timezone;
    await this.database.db.update(userSettings).set(values).where(eq(userSettings.userId, userId));
  }

  async setTimezone(userId: string, timezone: string): Promise<void> {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
    await this.database.db.update(userSettings).set({ timezone }).where(eq(userSettings.userId, userId));
  }

  async applyProfileTimezone(userId: string, target: "digests" | "quiet" | "both"): Promise<void> {
    const current = await this.get(userId);
    if (!current) throw new Error("settings missing");
    await this.database.db.update(userSettings).set({
      ...(target === "digests" || target === "both" ? { digestTimezone: current.timezone } : {}),
      ...(target === "quiet" || target === "both" ? { quietHoursTimezone: current.timezone } : {}),
    }).where(eq(userSettings.userId, userId));
  }

  async setLanguage(userId: string, language: string | null): Promise<string | null> {
    const normalized = language === null ? null : normalizeLanguageTag(language);
    await this.database.db.update(userSettings).set({ pinnedLanguage: normalized }).where(eq(userSettings.userId, userId));
    return normalized;
  }

  async setDigest(input: { userId: string; kind: "morning" | "evening"; enabled: boolean; time?: string }): Promise<void> {
    if (input.time) parseLocalTime(input.time);
    const current = await this.get(input.userId);
    if (!current) throw new Error("settings missing");
    const patch = input.kind === "morning"
      ? { morningDigestEnabled: input.enabled, digestTimezone: current.timezone, ...(input.time ? { morningReferenceTime: input.time } : {}) }
      : { eveningDigestEnabled: input.enabled, digestTimezone: current.timezone, ...(input.time ? { eveningReferenceTime: input.time } : {}) };
    await this.database.db.update(userSettings).set(patch).where(eq(userSettings.userId, input.userId));
  }

  async setWeekly(input: { userId: string; enabled: boolean; weekday?: number; time?: string }): Promise<void> {
    if (input.weekday !== undefined && (input.weekday < 1 || input.weekday > 7)) throw new Error("weekday must be 1..7");
    if (input.time) parseLocalTime(input.time);
    const current = await this.get(input.userId);
    if (!current) throw new Error("settings missing");
    await this.database.db.update(userSettings).set({
      weeklyReviewEnabled: input.enabled,
      digestTimezone: current.timezone,
      ...(input.weekday !== undefined ? { weeklyReviewWeekday: input.weekday } : {}),
      ...(input.time ? { weeklyReviewTime: input.time } : {}),
    }).where(eq(userSettings.userId, input.userId));
  }

  async snoozeUntil(userId: string, until: Date | null): Promise<void> {
    await this.database.db.update(userSettings).set({ notificationsSnoozedUntil: until }).where(eq(userSettings.userId, userId));
  }

  async snoozeUntilMorning(userId: string, now = new Date()): Promise<Date> {
    const settings = await this.get(userId);
    if (!settings) throw new Error("settings missing");
    const localToday = localDateAt(now, settings.timezone);
    let target = localDateAndTimeToUtc(localToday, settings.morningReferenceTime, settings.timezone).date;
    if (target <= now) target = localDateAndTimeToUtc(shiftLocalDate(localToday, 1), settings.morningReferenceTime, settings.timezone).date;
    await this.snoozeUntil(userId, target);
    return target;
  }

  async setReminderDefaults(input: {
    userId: string;
    eventOffsets?: number[];
    plannedTaskOffsetMinutes?: number;
    criticalPostDueMinutes?: number;
    seenNormalMinutes?: number;
    seenRequiredMinutes?: number;
    seenCriticalMinutes?: number;
  }): Promise<void> {
    const atLeast15 = (value: number | undefined, field: string) => {
      if (value !== undefined && (!Number.isInteger(value) || value < 15)) throw new Error(`${field} must be >= 15 minutes`);
    };
    atLeast15(input.criticalPostDueMinutes, "criticalPostDueMinutes");
    atLeast15(input.seenNormalMinutes, "seenNormalMinutes");
    atLeast15(input.seenRequiredMinutes, "seenRequiredMinutes");
    atLeast15(input.seenCriticalMinutes, "seenCriticalMinutes");
    if (input.eventOffsets) {
      if (!input.eventOffsets.length || input.eventOffsets.some((value) => !Number.isInteger(value))) throw new Error("event offsets must be integer minutes");
    }
    if (input.plannedTaskOffsetMinutes !== undefined && !Number.isInteger(input.plannedTaskOffsetMinutes)) {
      throw new Error("plannedTaskOffsetMinutes must be integer minutes");
    }
    const normalizedEventOffsets = input.eventOffsets ? [...new Set(input.eventOffsets)].sort((a, b) => a - b) : undefined;
    await this.database.db.update(userSettings).set({
      ...(normalizedEventOffsets ? { eventReminderOffsetsMinutes: normalizedEventOffsets } : {}),
      ...(input.plannedTaskOffsetMinutes !== undefined ? { plannedTaskReminderOffsetMinutes: input.plannedTaskOffsetMinutes } : {}),
      ...(input.criticalPostDueMinutes !== undefined ? { criticalPostDueMinutes: input.criticalPostDueMinutes } : {}),
      ...(input.seenNormalMinutes !== undefined ? { seenNormalMinutes: input.seenNormalMinutes } : {}),
      ...(input.seenRequiredMinutes !== undefined ? { seenRequiredMinutes: input.seenRequiredMinutes } : {}),
      ...(input.seenCriticalMinutes !== undefined ? { seenCriticalMinutes: input.seenCriticalMinutes } : {}),
    }).where(eq(userSettings.userId, input.userId));
  }

  async setPendingInput(userId: string, input: PendingInput | null): Promise<void> {
    await this.database.db.update(userSettings).set({ pendingInput: input }).where(eq(userSettings.userId, userId));
  }

  async consumePendingInput(userId: string): Promise<PendingInput | null> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx.select({ pendingInput: userSettings.pendingInput }).from(userSettings)
        .where(eq(userSettings.userId, userId)).for("update").limit(1);
      if (!row?.pendingInput) return null;
      await tx.update(userSettings).set({ pendingInput: null }).where(eq(userSettings.userId, userId));
      return row.pendingInput as PendingInput;
    });
  }

  async markSpendWarning(userId: string, month: string): Promise<boolean> {
    const [row] = await this.database.db.update(userSettings)
      .set({ lastAiSpendWarningMonth: month })
      .where(eq(userSettings.userId, userId))
      .returning({ userId: userSettings.userId });
    return Boolean(row);
  }
}
