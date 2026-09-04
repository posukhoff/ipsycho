import { Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { localDateAndTimeToUtc, localDateAt, shiftLocalDate } from "../core/timezone.js";
import { normalizeLanguageTag } from "../core/language.js";
import { buildSettingsPatch, type SettingsChange } from "../core/settings-change.js";
import { DatabaseService } from "../database/database.service.js";
import { userSettings } from "../database/schema.js";


export type PendingInput =
  | { kind: "timezone"; onboarding: boolean }
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

  /** Every setting change goes through one validated patch builder; the version bumps on each write. */
  async apply(userId: string, change: SettingsChange, now = new Date()): Promise<void> {
    const current = await this.get(userId);
    if (!current) throw new Error("settings missing");
    const patch = buildSettingsPatch(change, current);
    await this.database.db.update(userSettings).set({ ...patch, version: sql`${userSettings.version} + 1`, updatedAt: now }).where(eq(userSettings.userId, userId));
  }

  setDigestPreset(userId: string, enabled: boolean): Promise<void> {
    return this.apply(userId, { operation: "digest_preset", enabled });
  }

  setWeeklyPreset(userId: string, enabled: boolean): Promise<void> {
    return this.apply(userId, { operation: "weekly_preset", enabled });
  }

  setQuietHours(userId: string, update: QuietHoursUpdate): Promise<void> {
    return this.apply(userId, { operation: "quiet_hours", ...update });
  }

  setTimezone(userId: string, timezone: string, options: { applyTo?: "digests" | "quiet" | "both" } = {}): Promise<void> {
    return this.apply(userId, { operation: "timezone", timezone, applyTo: options.applyTo === "both" ? "all" : "profile_only" }).then(async () => {
      if (options.applyTo === "digests" || options.applyTo === "quiet") await this.applyProfileTimezone(userId, options.applyTo);
    });
  }

  async applyProfileTimezone(userId: string, target: "digests" | "quiet" | "both"): Promise<void> {
    const current = await this.get(userId);
    if (!current) throw new Error("settings missing");
    await this.database.db.update(userSettings).set({
      ...(target === "digests" || target === "both" ? { digestTimezone: current.timezone } : {}),
      ...(target === "quiet" || target === "both" ? { quietHoursTimezone: current.timezone } : {}),
      version: sql`${userSettings.version} + 1`, updatedAt: new Date(),
    }).where(eq(userSettings.userId, userId));
  }

  async setLanguage(userId: string, language: string | null): Promise<string | null> {
    const normalized = language === null ? null : normalizeLanguageTag(language);
    await this.apply(userId, { operation: "language", language: normalized });
    return normalized;
  }

  setDigest(input: { userId: string; kind: "morning" | "evening"; enabled: boolean; time?: string }): Promise<void> {
    return this.apply(input.userId, { operation: "digest", kind: input.kind, enabled: input.enabled, time: input.time ?? null });
  }

  setWeekly(input: { userId: string; enabled: boolean; weekday?: number; time?: string }): Promise<void> {
    return this.apply(input.userId, { operation: "weekly_review", enabled: input.enabled, weekday: input.weekday ?? null, time: input.time ?? null });
  }

  snoozeUntil(userId: string, until: Date | null): Promise<void> {
    return this.apply(userId, { operation: "snooze", until });
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

  setReminderDefaults(input: {
    userId: string;
    eventOffsets?: number[];
    plannedTaskOffsetMinutes?: number;
    criticalPostDueMinutes?: number;
    seenNormalMinutes?: number;
    seenRequiredMinutes?: number;
    seenCriticalMinutes?: number;
  }): Promise<void> {
    const { userId, ...fields } = input;
    return this.apply(userId, { operation: "reminder_defaults", ...fields });
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
