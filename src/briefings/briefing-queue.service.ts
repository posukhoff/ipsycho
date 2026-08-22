import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { briefingStillUseful, type BriefingKind } from "../core/digest-policy.js";
import { isQuietAt } from "../core/quiet-hours.js";
import { localDateAt } from "../core/timezone.js";
import { DatabaseService } from "../database/database.service.js";
import { briefingDeliveries, userSettings, users, workspaceMembers } from "../database/schema.js";
import { TelegramService } from "../telegram/telegram.service.js";
import { BriefingContentService } from "./briefing-content.service.js";
import { safeError } from "../observability/safe-error.js";

const QUEUE = "briefing-delivery";
const MAX_ATTEMPTS = 3;

@Injectable()
export class BriefingQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly boss: PgBoss;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly database: DatabaseService,
    private readonly telegram: TelegramService,
    private readonly content: BriefingContentService,
  ) {
    this.boss = new PgBoss(config.databaseUrl);
    this.boss.on("error", (error) => console.error("pg-boss queue error", { queue: QUEUE, error: safeError(error) }));
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.start();
    await this.boss.createQueue(QUEUE);
    await this.boss.work<{ deliveryId: string }>(QUEUE, async ([job]) => { if (job) await this.deliver(job.data.deliveryId); });
    await this.database.db.update(briefingDeliveries).set({ status: "pending" }).where(eq(briefingDeliveries.status, "processing"));
    const pending = await this.database.db.select({ id: briefingDeliveries.id, scheduledFor: briefingDeliveries.scheduledFor }).from(briefingDeliveries)
      .where(eq(briefingDeliveries.status, "pending")).limit(1000);
    for (const row of pending) await this.enqueue(row.id, row.scheduledFor).catch((error) => console.error("briefing boot enqueue deferred", { deliveryId: row.id, error: safeError(error) }));
  }

  async onApplicationShutdown(): Promise<void> { await this.boss.stop(); }

  async enqueue(deliveryId: string, scheduledFor: Date): Promise<void> {
    await this.boss.send(QUEUE, { deliveryId }, {
      startAfter: scheduledFor > new Date() ? scheduledFor : new Date(),
      singletonKey: `${deliveryId}:${scheduledFor.toISOString()}`,
      retryLimit: MAX_ATTEMPTS - 1,
      retryDelay: 30,
      retryBackoff: true,
    });
  }

  private async deliver(deliveryId: string): Promise<void> {
    const [row] = await this.database.db.select({ delivery: briefingDeliveries, user: users, settings: userSettings })
      .from(briefingDeliveries)
      .innerJoin(users, eq(users.id, briefingDeliveries.recipientUserId))
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, briefingDeliveries.workspaceId), eq(workspaceMembers.userId, briefingDeliveries.recipientUserId)))
      .innerJoin(userSettings, eq(userSettings.userId, briefingDeliveries.recipientUserId))
      .where(eq(briefingDeliveries.id, deliveryId)).limit(1);
    if (!row || row.delivery.status !== "pending") return;
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
    if (row.settings.quietHoursEnabled && isQuietAt(next, row.settings.quietHoursTimezone, {
      enabled: true,
      weekday: { start: row.settings.weekdayQuietStart, end: row.settings.weekdayQuietEnd },
      weekend: { start: row.settings.weekendQuietStart, end: row.settings.weekendQuietEnd },
    })) next = nextNonQuiet(next, row.settings.quietHoursTimezone, row.settings);
    if (next > now) {
      if (localDateAt(next, row.settings.digestTimezone) !== row.delivery.localDate) return this.suppress(deliveryId, deferredBySnooze ? "snooze_stale" : "quiet_stale");
      await this.database.db.update(briefingDeliveries).set({ scheduledFor: next }).where(and(eq(briefingDeliveries.id, deliveryId), eq(briefingDeliveries.status, "pending")));
      return this.enqueue(deliveryId, next);
    }

    const [claimed] = await this.database.db.update(briefingDeliveries).set({ status: "processing", attempts: row.delivery.attempts + 1 })
      .where(and(eq(briefingDeliveries.id, deliveryId), eq(briefingDeliveries.status, "pending"))).returning({ id: briefingDeliveries.id });
    if (!claimed) return;
    try {
      const built = await this.content.build({ workspaceId: row.delivery.workspaceId, kind: row.delivery.kind as BriefingKind, localDate: row.delivery.localDate, timezone: row.settings.digestTimezone, now });
      if (!built.hasContent) {
        await this.database.db.update(briefingDeliveries).set({ status: "suppressed", suppressedReason: "empty" }).where(and(eq(briefingDeliveries.id, deliveryId), eq(briefingDeliveries.status, "processing")));
        return;
      }
      const messageId = await this.telegram.sendBriefing(row.user.telegramUserId, row.delivery.kind as BriefingKind, built.text, built.decisionOccurrenceIds, built.reviewKinds, row.delivery.id);
      await this.database.db.update(briefingDeliveries).set({ status: "sent", sentAt: new Date(), telegramMessageId: messageId })
        .where(and(eq(briefingDeliveries.id, deliveryId), eq(briefingDeliveries.status, "processing")));
    } catch (error) {
      await this.database.db.update(briefingDeliveries).set({ status: row.delivery.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending" })
        .where(and(eq(briefingDeliveries.id, deliveryId), eq(briefingDeliveries.status, "processing")));
      throw error;
    }
  }

  private async suppress(id: string, reason: "access" | "quiet_stale" | "snooze_stale" | "no_longer_applicable" | "empty"): Promise<void> {
    await this.database.db.update(briefingDeliveries).set({ status: "suppressed", suppressedReason: reason })
      .where(and(eq(briefingDeliveries.id, id), eq(briefingDeliveries.status, "pending")));
  }
}

function nextNonQuiet(at: Date, timezone: string, settings: typeof userSettings.$inferSelect): Date {
  let cursor = new Date(Math.ceil(at.getTime() / 60_000) * 60_000);
  const quiet = { enabled: true, weekday: { start: settings.weekdayQuietStart, end: settings.weekdayQuietEnd }, weekend: { start: settings.weekendQuietStart, end: settings.weekendQuietEnd } };
  for (let i = 0; i < 36 * 60; i += 1) {
    if (!isQuietAt(cursor, timezone, quiet)) return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return cursor;
}
