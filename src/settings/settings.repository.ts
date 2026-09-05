import { Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { userSettings } from "../database/schema.js";

/** A pending free-text prompt: the next message answers this button instead of going to the model. */
export type PendingInput =
  | { kind: "timezone"; onboarding: boolean }
  | { kind: "reschedule"; occurrenceId: string }
  | { kind: "quick_reschedule_reason"; occurrenceId: string; choice: "1h" | "evening" | "tomorrow" }
  | { kind: "blocker"; occurrenceId: string }
  | { kind: "follow_up_custom"; occurrenceId: string; mode: "snooze" | "result" };

export type SettingsRow = typeof userSettings.$inferSelect;

/** Every read and write of `user_settings`. The service above it holds the rules, not the SQL. */
@Injectable()
export class SettingsRepository {
  constructor(private readonly database: DatabaseService) {}

  async find(userId: string): Promise<SettingsRow | null> {
    const [row] = await this.database.db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
    return row ?? null;
  }

  async markOnboardingCompleted(userId: string, now: Date): Promise<void> {
    await this.database.db.update(userSettings).set({ onboardingCompletedAt: now }).where(eq(userSettings.userId, userId));
  }

  /** One write, one version bump: readers compare that version before acting on stale settings. */
  async applyPatch(userId: string, patch: Partial<SettingsRow>, now: Date): Promise<void> {
    await this.database.db
      .update(userSettings)
      .set({ ...patch, version: sql`${userSettings.version} + 1`, updatedAt: now })
      .where(eq(userSettings.userId, userId));
  }

  async copyProfileTimezone(userId: string, timezone: string, target: "digests" | "quiet" | "both", now: Date): Promise<void> {
    await this.applyPatch(
      userId,
      {
        ...(target === "digests" || target === "both" ? { digestTimezone: timezone } : {}),
        ...(target === "quiet" || target === "both" ? { quietHoursTimezone: timezone } : {}),
      },
      now,
    );
  }

  async setPendingInput(userId: string, input: PendingInput | null): Promise<void> {
    await this.database.db.update(userSettings).set({ pendingInput: input }).where(eq(userSettings.userId, userId));
  }

  /** Read and clear in one transaction: a pending prompt must be answered exactly once. */
  async consumePendingInput(userId: string): Promise<PendingInput | null> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx.select({ pendingInput: userSettings.pendingInput }).from(userSettings).where(eq(userSettings.userId, userId)).for("update").limit(1);
      if (!row?.pendingInput) return null;
      await tx.update(userSettings).set({ pendingInput: null }).where(eq(userSettings.userId, userId));
      return row.pendingInput as PendingInput;
    });
  }

  async markSpendWarning(userId: string, month: string): Promise<boolean> {
    const [row] = await this.database.db
      .update(userSettings)
      .set({ lastAiSpendWarningMonth: month })
      .where(eq(userSettings.userId, userId))
      .returning({ userId: userSettings.userId });
    return Boolean(row);
  }
}
