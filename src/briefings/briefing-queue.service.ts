import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { and, asc, eq, lte } from "drizzle-orm";
import { briefingStillUseful, type BriefingKind } from "../core/digest-policy.js";
import { isQuietAt } from "../core/quiet-hours.js";
import { localDateAt } from "../core/timezone.js";
import { DatabaseService } from "../database/database.service.js";
import { briefingDeliveries, userSettings, users, workspaceMembers } from "../database/schema.js";
import { JobQueueService } from "../queue/job-queue.service.js";
import { telegramLocale } from "../telegram/telegram-locale.js";
import { TelegramService } from "../telegram/telegram.service.js";
import { classifyTelegramSendError } from "../telegram/telegram-send-outcome.js";
import { BriefingContentService } from "./briefing-content.service.js";
import { safeError } from "../observability/safe-error.js";
import { logger } from "../observability/logger.js";

export const BRIEFING_QUEUE = "briefing-delivery";
const MAX_ATTEMPTS = 3;
const BOOT_HORIZON_MS = 48 * 60 * 60_000;

@Injectable()
export class BriefingQueueService implements OnApplicationBootstrap {
  constructor(
    private readonly database: DatabaseService,
    private readonly telegram: TelegramService,
    private readonly content: BriefingContentService,
    private readonly queue: JobQueueService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.ensureQueue(BRIEFING_QUEUE, { retryLimit: MAX_ATTEMPTS - 1, retryDelaySeconds: 30 });
    // Recovery before the worker starts, for the same reason as in ReminderQueueService.
    await this.database.db.update(briefingDeliveries).set({ status: "pending" }).where(eq(briefingDeliveries.status, "processing"));
    const pending = await this.database.db
      .select({ id: briefingDeliveries.id, scheduledFor: briefingDeliveries.scheduledFor })
      .from(briefingDeliveries)
      .where(and(eq(briefingDeliveries.status, "pending"), lte(briefingDeliveries.scheduledFor, new Date(Date.now() + BOOT_HORIZON_MS))))
      .orderBy(asc(briefingDeliveries.scheduledFor));
    for (const row of pending)
      await this.enqueue(row.id, row.scheduledFor).catch((error) => logger.error("briefing boot enqueue deferred", { deliveryId: row.id, error: safeError(error) }));
    await this.queue.work<{ deliveryId: string }>(BRIEFING_QUEUE, (data) => this.deliver(data.deliveryId));
  }

  async enqueue(deliveryId: string, scheduledFor: Date): Promise<void> {
    await this.queue.send(
      BRIEFING_QUEUE,
      { deliveryId },
      {
        startAfter: scheduledFor > new Date() ? scheduledFor : new Date(),
        singletonKey: `${deliveryId}:${scheduledFor.toISOString()}`,
      },
    );
  }

  private async deliver(deliveryId: string): Promise<void> {
    const [row] = await this.database.db
      .select({ delivery: briefingDeliveries, user: users, settings: userSettings })
      .from(briefingDeliveries)
      .innerJoin(users, eq(users.id, briefingDeliveries.recipientUserId))
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, briefingDeliveries.workspaceId), eq(workspaceMembers.userId, briefingDeliveries.recipientUserId)))
      .innerJoin(userSettings, eq(userSettings.userId, briefingDeliveries.recipientUserId))
      .where(eq(briefingDeliveries.id, deliveryId))
      .limit(1);
    if (!row) return this.suppress(deliveryId, "orphaned");
    if (row.delivery.status !== "pending") return;
    if (row.user.status !== "active") return this.suppress(deliveryId, "access");

    const now = new Date();
    if (row.delivery.scheduledFor > now) return this.enqueue(deliveryId, row.delivery.scheduledFor);
    const currentLocalDate = localDateAt(now, row.settings.digestTimezone);
    if (!briefingStillUseful(row.delivery.kind as BriefingKind, row.delivery.localDate, currentLocalDate)) return this.suppress(deliveryId, "no_longer_applicable");

    let next = now;
    let deferredBySnooze = false;
    if (row.settings.notificationsSnoozedUntil && row.settings.notificationsSnoozedUntil > next) {
      next = row.settings.notificationsSnoozedUntil;
      deferredBySnooze = true;
    }
    if (
      row.settings.quietHoursEnabled &&
      isQuietAt(next, row.settings.quietHoursTimezone, {
        enabled: true,
        weekday: { start: row.settings.weekdayQuietStart, end: row.settings.weekdayQuietEnd },
        weekend: { start: row.settings.weekendQuietStart, end: row.settings.weekendQuietEnd },
      })
    )
      next = nextNonQuiet(next, row.settings.quietHoursTimezone, row.settings);
    if (next > now) {
      if (localDateAt(next, row.settings.digestTimezone) !== row.delivery.localDate) return this.suppress(deliveryId, deferredBySnooze ? "snooze_stale" : "quiet_stale");
      await this.database.db
        .update(briefingDeliveries)
        .set({ scheduledFor: next })
        .where(and(eq(briefingDeliveries.id, deliveryId), eq(briefingDeliveries.status, "pending")));
      return this.enqueue(deliveryId, next);
    }

    const [claimed] = await this.database.db
      .update(briefingDeliveries)
      .set({ status: "processing", attempts: row.delivery.attempts + 1 })
      .where(and(eq(briefingDeliveries.id, deliveryId), eq(briefingDeliveries.status, "pending")))
      .returning({ id: briefingDeliveries.id });
    if (!claimed) return;
    try {
      const built = await this.content.build({
        workspaceId: row.delivery.workspaceId,
        kind: row.delivery.kind as BriefingKind,
        localDate: row.delivery.localDate,
        timezone: row.settings.digestTimezone,
        now,
        locale: telegramLocale(row.settings.pinnedLanguage),
      });
      if (!built.hasContent) {
        await this.database.db
          .update(briefingDeliveries)
          .set({ status: "suppressed", suppressedReason: "empty" })
          .where(and(eq(briefingDeliveries.id, deliveryId), eq(briefingDeliveries.status, "processing")));
        return;
      }
      const messageId = await this.telegram.sendBriefing(
        row.user.telegramUserId,
        row.delivery.kind as BriefingKind,
        built.text,
        built.decisionOccurrenceIds,
        built.reviewKinds,
        row.delivery.id,
        telegramLocale(row.settings.pinnedLanguage),
      );
      await this.database.db
        .update(briefingDeliveries)
        .set({ status: "sent", sentAt: new Date(), telegramMessageId: messageId })
        .where(and(eq(briefingDeliveries.id, deliveryId), eq(briefingDeliveries.status, "processing")));
    } catch (error) {
      const processing = and(eq(briefingDeliveries.id, deliveryId), eq(briefingDeliveries.status, "processing"));
      const outcome = classifyTelegramSendError(error);
      if (outcome.kind === "rate_limited") {
        const retryAt = new Date(Date.now() + outcome.retryAfterSeconds * 1000);
        await this.database.db.update(briefingDeliveries).set({ status: "pending", attempts: row.delivery.attempts, scheduledFor: retryAt }).where(processing);
        return this.enqueue(deliveryId, retryAt);
      }
      if (outcome.kind === "rejected") {
        logger.warn("briefing rejected by Telegram", { deliveryId, errorCode: outcome.errorCode });
        await this.database.db.update(briefingDeliveries).set({ status: "failed" }).where(processing);
        return;
      }
      if (outcome.kind === "ambiguous") {
        logger.warn("briefing send outcome ambiguous", { deliveryId, error: safeError(error) });
        await this.database.db.update(briefingDeliveries).set({ status: "ambiguous", sentAt: new Date() }).where(processing);
        return;
      }
      await this.database.db
        .update(briefingDeliveries)
        .set({ status: row.delivery.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending" })
        .where(processing);
      throw error;
    }
  }

  private async suppress(id: string, reason: "access" | "quiet_stale" | "snooze_stale" | "no_longer_applicable" | "empty" | "orphaned"): Promise<void> {
    await this.database.db
      .update(briefingDeliveries)
      .set({ status: "suppressed", suppressedReason: reason })
      .where(and(eq(briefingDeliveries.id, id), eq(briefingDeliveries.status, "pending")));
  }
}

function nextNonQuiet(at: Date, timezone: string, settings: typeof userSettings.$inferSelect): Date {
  let cursor = new Date(Math.ceil(at.getTime() / 60_000) * 60_000);
  const quiet = {
    enabled: true,
    weekday: { start: settings.weekdayQuietStart, end: settings.weekdayQuietEnd },
    weekend: { start: settings.weekendQuietStart, end: settings.weekendQuietEnd },
  };
  for (let i = 0; i < 36 * 60; i += 1) {
    if (!isQuietAt(cursor, timezone, quiet)) return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return cursor;
}
