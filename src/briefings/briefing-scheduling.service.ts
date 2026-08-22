import { randomUUID } from "node:crypto";
import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { localDateAndTimeToUtc, localDateAt, parseLocalDate, shiftLocalDate } from "../core/timezone.js";
import { DatabaseService } from "../database/database.service.js";
import { briefingDeliveries, userSettings, users, workspaceMembers, workspaces } from "../database/schema.js";
import { BriefingQueueService } from "./briefing-queue.service.js";
import { safeError } from "../observability/safe-error.js";

const RECONCILE_MS = 15 * 60_000;

@Injectable()
export class BriefingSchedulingService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly database: DatabaseService, private readonly queue: BriefingQueueService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
    this.timer = setInterval(() => void this.reconcile().catch((error) => console.error("briefing scheduling reconciliation failed", safeError(error))), RECONCILE_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async reconcile(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.database.db.select({ user: users, settings: userSettings, workspaceId: workspaces.id })
        .from(users)
        .innerJoin(userSettings, eq(userSettings.userId, users.id))
        .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
        .innerJoin(workspaces, and(eq(workspaces.id, workspaceMembers.workspaceId), eq(workspaces.ownerUserId, users.id), eq(workspaces.kind, "personal")))
        .where(eq(users.status, "active"));
      for (const row of rows) {
        const today = localDateAt(now, row.settings.digestTimezone);
        for (const date of [today, shiftLocalDate(today, 1)]) await this.materializeDate(row.workspaceId, row.user.id, row.settings, date, now);
      }
    } finally {
      this.running = false;
    }
  }

  private async materializeDate(workspaceId: string, userId: string, settings: typeof userSettings.$inferSelect, localDate: string, now: Date): Promise<void> {
    parseLocalDate(localDate);
    const weekday = localWeekday(localDate);
    const bundle = settings.eveningDigestEnabled && settings.weeklyReviewEnabled && weekday === settings.weeklyReviewWeekday && settings.eveningReferenceTime === settings.weeklyReviewTime;
    const expected: Array<{ kind: "morning" | "evening" | "weekly" | "evening_weekly"; time: string }> = [];
    if (settings.morningDigestEnabled) expected.push({ kind: "morning", time: settings.morningReferenceTime });
    if (bundle) expected.push({ kind: "evening_weekly", time: settings.eveningReferenceTime });
    else {
      if (settings.eveningDigestEnabled) expected.push({ kind: "evening", time: settings.eveningReferenceTime });
      if (settings.weeklyReviewEnabled && weekday === settings.weeklyReviewWeekday) expected.push({ kind: "weekly", time: settings.weeklyReviewTime });
    }

    const expectedItems = expected.map((item) => ({
      ...item,
      scheduledFor: localDateAndTimeToUtc(localDate, item.time, settings.digestTimezone).date,
      deduplicationKey: `${userId}:${item.kind}:${localDate}:${item.time}`,
    }));
    const expectedKeys = new Set(expectedItems.map((item) => item.deduplicationKey));
    const existing = await this.database.db.select().from(briefingDeliveries).where(and(
      eq(briefingDeliveries.workspaceId, workspaceId), eq(briefingDeliveries.recipientUserId, userId), eq(briefingDeliveries.localDate, localDate),
    ));
    const existingByKey = new Map(existing.map((delivery) => [delivery.deduplicationKey, delivery]));

    for (const delivery of existing) {
      if (["pending", "processing"].includes(delivery.status) && !expectedKeys.has(delivery.deduplicationKey)) {
        await this.database.db.update(briefingDeliveries).set({ status: "suppressed", suppressedReason: "superseded" }).where(and(
          eq(briefingDeliveries.id, delivery.id), inArray(briefingDeliveries.status, ["pending", "processing"]),
        ));
      }
    }

    for (const item of expectedItems) {
      if (item.scheduledFor < new Date(now.getTime() - 24 * 60 * 60_000)) continue;
      const prior = existingByKey.get(item.deduplicationKey);
      if (prior) {
        if (prior.status === "sent" || prior.status === "processing" || prior.status === "failed") continue;
        if (prior.status === "suppressed" && item.scheduledFor <= now) continue;
        if (prior.status !== "pending" || prior.scheduledFor.getTime() !== item.scheduledFor.getTime()) {
          await this.database.db.update(briefingDeliveries).set({
            scheduledFor: item.scheduledFor, status: "pending", suppressedReason: null,
          }).where(eq(briefingDeliveries.id, prior.id));
        }
        await this.queue.enqueue(prior.id, item.scheduledFor).catch((error) => console.error("briefing enqueue deferred", { deliveryId: prior.id, error: safeError(error) }));
        continue;
      }

      const id = randomUUID();
      const [delivery] = await this.database.db.insert(briefingDeliveries).values({
        id, workspaceId, recipientUserId: userId, kind: item.kind, localDate, scheduledFor: item.scheduledFor, deduplicationKey: item.deduplicationKey,
      }).onConflictDoNothing().returning({ id: briefingDeliveries.id, scheduledFor: briefingDeliveries.scheduledFor, status: briefingDeliveries.status });
      if (delivery?.status === "pending") await this.queue.enqueue(delivery.id, delivery.scheduledFor).catch((error) => console.error("briefing enqueue deferred", { deliveryId: delivery.id, error: safeError(error) }));
    }

  }
}

function localWeekday(localDate: string): number {
  const { year, month, day } = parseLocalDate(localDate);
  const js = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return js === 0 ? 7 : js;
}
