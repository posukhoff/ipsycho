import { Injectable } from "@nestjs/common";
import { localDateAndTimeToUtc, localDateAt, shiftLocalDate } from "../core/timezone.js";
import { normalizeLanguageTag } from "../core/language.js";
import { buildSettingsPatch, type SettingsChange } from "../core/settings-change.js";
import { SettingsRepository, type PendingInput } from "./settings.repository.js";

export type { PendingInput };

export interface QuietHoursUpdate {
  enabled: boolean;
  weekdayStart?: string;
  weekdayEnd?: string;
  weekendStart?: string;
  weekendEnd?: string;
}

@Injectable()
export class SettingsService {
  constructor(private readonly repository: SettingsRepository) {}

  get(userId: string) {
    return this.repository.find(userId);
  }

  completeOnboarding(userId: string, now = new Date()): Promise<void> {
    return this.repository.markOnboardingCompleted(userId, now);
  }

  /** Every setting change goes through one validated patch builder; the version bumps on each write. */
  async apply(userId: string, change: SettingsChange, now = new Date()): Promise<void> {
    const current = await this.get(userId);
    if (!current) throw new Error("settings missing");
    await this.repository.applyPatch(userId, buildSettingsPatch(change, current), now);
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
    await this.repository.copyProfileTimezone(userId, current.timezone, target, new Date());
  }

  async setLanguage(userId: string, language: string | null): Promise<string | null> {
    const normalized = language === null ? null : normalizeLanguageTag(language);
    await this.apply(userId, { operation: "language", language: normalized });
    return normalized;
  }

  setDigest(input: { userId: string; kind: "morning"; enabled: boolean; time?: string }): Promise<void> {
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

  setReminderDefaults(input: { userId: string; eventOffsets?: number[]; plannedTaskOffsetMinutes?: number; criticalPostDueMinutes?: number }): Promise<void> {
    const { userId, ...fields } = input;
    return this.apply(userId, { operation: "reminder_defaults", ...fields });
  }

  setPendingInput(userId: string, input: PendingInput | null): Promise<void> {
    return this.repository.setPendingInput(userId, input);
  }

  consumePendingInput(userId: string): Promise<PendingInput | null> {
    return this.repository.consumePendingInput(userId);
  }

  markSpendWarning(userId: string, month: string): Promise<boolean> {
    return this.repository.markSpendWarning(userId, month);
  }
}
