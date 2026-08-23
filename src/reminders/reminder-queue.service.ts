import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { DatabaseService } from "../database/database.service.js";
import { briefingDeliveries, reminderDeliveries, reminderRules, taskChecklistItems, taskEvents, taskOccurrences, tasks, users, userSettings, workspaceMembers } from "../database/schema.js";
import { TelegramService } from "../telegram/telegram.service.js";
import { reminderCardText } from "../telegram/telegram-ui.js";
import { occurrenceProjectionFromRow, reminderRuleSpecFromRow, reminderSettingsFromRow, taskDefinitionFromRow } from "../tasks/task-record-mappers.js";
import { applyNotificationPolicy } from "../core/reminder-planning.js";
import { nextCriticalEscalationAt, reminderBriefingBundleDecision } from "../core/reminder-escalation.js";
import { safeError } from "../observability/safe-error.js";

const QUEUE = "reminder-delivery";
const MAX_DELIVERY_ATTEMPTS = 3;
const RECONCILE_INTERVAL_MS = 60_000;

type ReminderDeliveryRow = {
  delivery: typeof reminderDeliveries.$inferSelect;
  rule: typeof reminderRules.$inferSelect;
  settings: typeof userSettings.$inferSelect;
  task: typeof tasks.$inferSelect;
  occurrence: typeof taskOccurrences.$inferSelect | null;
  telegramUserId: number;
  userStatus: typeof users.$inferSelect["status"];
};

@Injectable()
export class ReminderQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly boss: PgBoss;
  private reconcileTimer?: NodeJS.Timeout;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly database: DatabaseService,
    private readonly telegram: TelegramService,
  ) {
    this.boss = new PgBoss(config.databaseUrl);
    this.boss.on("error", (error) => console.error("pg-boss queue error", { queue: QUEUE, error: safeError(error) }));
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.start();
    await this.boss.createQueue(QUEUE);
    await this.boss.work<{ deliveryId: string }>(QUEUE, async ([job]) => {
      if (job) await this.deliver(job.data.deliveryId);
    });
    // Only boot recovery may reset processing rows. Periodic reconciliation never touches
    // in-flight work; it only repairs pending rows that have no usable queue job.
    await this.database.db.update(reminderDeliveries)
      .set({ status: "pending" })
      .where(eq(reminderDeliveries.status, "processing"));
    await this.enqueuePending();
    this.reconcileTimer = setInterval(() => void this.enqueuePending(new Date(Date.now() + 2 * 60_000)).catch((error) => console.error("reminder queue reconciliation failed", safeError(error))), RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await this.boss.stop();
  }

  async enqueue(deliveryId: string, scheduledFor: Date): Promise<void> {
    const startAfter = scheduledFor > new Date() ? scheduledFor : new Date();
    await this.boss.send(QUEUE, { deliveryId }, {
      startAfter,
      singletonKey: `${deliveryId}:${scheduledFor.toISOString()}`,
      retryLimit: MAX_DELIVERY_ATTEMPTS - 1,
      retryDelay: 30,
      retryBackoff: true,
    });
  }

  private async enqueuePending(horizon?: Date): Promise<void> {
    const predicate = horizon
      ? and(eq(reminderDeliveries.status, "pending"), lte(reminderDeliveries.scheduledFor, horizon))
      : eq(reminderDeliveries.status, "pending");
    const pending = await this.database.db.select({
      id: reminderDeliveries.id,
      scheduledFor: reminderDeliveries.scheduledFor,
    }).from(reminderDeliveries).where(predicate).limit(1000);

    for (const delivery of pending) {
      try {
        await this.enqueue(delivery.id, delivery.scheduledFor);
      } catch (error) {
        console.error("failed to reconcile reminder", { deliveryId: delivery.id, error: safeError(error) });
      }
    }
  }

  private async deliver(deliveryId: string): Promise<void> {
    const rows = await this.database.db
      .select({
        delivery: reminderDeliveries,
        rule: reminderRules,
        settings: userSettings,
        task: tasks,
        occurrence: taskOccurrences,
        telegramUserId: users.telegramUserId,
        userStatus: users.status,
      })
      .from(reminderDeliveries)
      .innerJoin(users, eq(users.id, reminderDeliveries.recipientUserId))
      .innerJoin(workspaceMembers, and(
        eq(workspaceMembers.workspaceId, reminderDeliveries.workspaceId),
        eq(workspaceMembers.userId, reminderDeliveries.recipientUserId),
      ))
      .innerJoin(tasks, and(
        eq(tasks.workspaceId, reminderDeliveries.workspaceId),
        eq(tasks.id, reminderDeliveries.taskId),
      ))
      .innerJoin(reminderRules, and(
        eq(reminderRules.workspaceId, reminderDeliveries.workspaceId),
        eq(reminderRules.id, reminderDeliveries.reminderRuleId),
      ))
      .innerJoin(userSettings, eq(userSettings.userId, reminderDeliveries.recipientUserId))
      .leftJoin(taskOccurrences, and(
        eq(taskOccurrences.workspaceId, reminderDeliveries.workspaceId),
        eq(taskOccurrences.id, reminderDeliveries.occurrenceId),
      ))
      .where(eq(reminderDeliveries.id, deliveryId))
      .limit(1);
    const row = rows[0];
    if (!row || row.delivery.status !== "pending") return;

    if (row.userStatus !== "active") {
      await this.suppress(deliveryId, "access");
      return;
    }
    const terminalOccurrence = row.occurrence?.status && ["done", "skipped", "cancelled", "elapsed"].includes(row.occurrence.status);
    if (row.occurrence?.defaultRemindersSuppressed && row.rule.origin === "default") {
      await this.suppress(deliveryId, "no_longer_applicable");
      return;
    }
    if (row.task.status === "closed" || row.task.status === "cancelled" || terminalOccurrence) {
      await this.suppress(deliveryId, "no_longer_applicable");
      return;
    }

    const now = new Date();
    // Re-evaluate quiet hours and snooze at delivery time because settings may have changed
    // after this delivery was materialized. Snooze is intentionally stronger than bypass.
    const policy = applyNotificationPolicy({
      intendedFor: row.delivery.intendedFor,
      now,
      task: taskDefinitionFromRow(row.task),
      occurrence: row.occurrence ? occurrenceProjectionFromRow(row.occurrence) : null,
      rule: reminderRuleSpecFromRow(row.rule),
      settings: reminderSettingsFromRow(row.settings),
    });
    if (policy.suppressedReason) {
      console.warn("reminder suppressed by delivery-time policy", {
        deliveryId,
        taskId: row.task.id,
        occurrenceId: row.occurrence?.id ?? null,
        intendedFor: row.delivery.intendedFor.toISOString(),
        evaluatedAt: now.toISOString(),
        latenessMs: now.getTime() - row.delivery.intendedFor.getTime(),
        reason: policy.suppressedReason,
      });
      await this.suppress(deliveryId, policy.suppressedReason);
      return;
    }
    if (policy.scheduledFor.getTime() > now.getTime() + 500) {
      await this.database.db.update(reminderDeliveries)
        .set({ scheduledFor: policy.scheduledFor })
        .where(and(eq(reminderDeliveries.id, deliveryId), eq(reminderDeliveries.status, "pending")));
      await this.enqueue(deliveryId, policy.scheduledFor);
      return;
    }

    const bundle = await this.bundleWithBriefing(row, now);
    if (bundle === "suppress") {
      await this.suppress(deliveryId, "superseded");
      // The digest is the contact for this slot. Critical post-due escalation must still
      // continue from that contact while the obligation remains open.
      await this.scheduleNextCriticalEscalation(row, now);
      return;
    }
    if (bundle === "wait") {
      await this.enqueue(deliveryId, new Date(now.getTime() + 60_000));
      return;
    }

    const nextAttempt = row.delivery.attempts + 1;
    const [claimed] = await this.database.db.update(reminderDeliveries)
      .set({ status: "processing", attempts: nextAttempt })
      .where(and(eq(reminderDeliveries.id, deliveryId), eq(reminderDeliveries.status, "pending")))
      .returning();
    if (!claimed) return;

    try {
      const checklist = await this.database.db.select({ text: taskChecklistItems.text, done: taskChecklistItems.done }).from(taskChecklistItems)
        .where(and(eq(taskChecklistItems.workspaceId, row.task.workspaceId), eq(taskChecklistItems.taskId, row.task.id)))
        .orderBy(taskChecklistItems.sortOrder)
        .catch(() => []);
      const text = reminderCardText({
        task: { ...row.task, checklist },
        occurrence: row.occurrence,
        purpose: row.rule.purpose,
        now,
      });
      const telegramMessageId = await this.telegram.sendReminder(
        row.telegramUserId,
        text,
        row.delivery.occurrenceId ?? undefined,
        row.occurrence?.status ?? "open",
      );
      const sentAt = new Date();
      await this.database.db.update(reminderDeliveries)
        .set({ status: "sent", sentAt, telegramMessageId })
        .where(and(eq(reminderDeliveries.id, deliveryId), eq(reminderDeliveries.status, "processing")));
      if (row.rule.purpose === "follow_up" && row.occurrence?.status === "in_progress" && row.rule.origin === "system") {
        await this.database.db.insert(taskEvents).values({
          workspaceId: row.delivery.workspaceId, taskId: row.task.id, occurrenceId: row.occurrence.id, eventType: "occurrence:result_check_sent", createdAt: sentAt,
        }).catch((error) => console.error("result-check event persistence failed", { occurrenceId: row.occurrence?.id, error: safeError(error) }));
      }
      await this.scheduleNextCriticalEscalation(row, sentAt);
    } catch (error) {
      // A concurrent reschedule/cancel may deliberately move a processing delivery to
      // cancelled while the external send is in flight. Never revive that stale delivery.
      await this.database.db.update(reminderDeliveries)
        .set({ status: nextAttempt >= MAX_DELIVERY_ATTEMPTS ? "failed" : "pending" })
        .where(and(eq(reminderDeliveries.id, deliveryId), eq(reminderDeliveries.status, "processing")));
      throw error;
    }
  }

  private async bundleWithBriefing(row: ReminderDeliveryRow, now: Date): Promise<"none" | "wait" | "suppress"> {
    if (row.rule.origin !== "default" || row.task.timeMode !== "deadline" || row.task.importance === "normal") return "none";
    const lower = new Date(row.delivery.scheduledFor.getTime() - 60_000);
    const upper = new Date(row.delivery.scheduledFor.getTime() + 60_000);
    const candidates = await this.database.db.select({
      scheduledFor: briefingDeliveries.scheduledFor,
      status: briefingDeliveries.status,
    }).from(briefingDeliveries).where(and(
      eq(briefingDeliveries.workspaceId, row.delivery.workspaceId),
      eq(briefingDeliveries.recipientUserId, row.delivery.recipientUserId),
      gte(briefingDeliveries.scheduledFor, lower),
      lte(briefingDeliveries.scheduledFor, upper),
      inArray(briefingDeliveries.status, ["pending", "processing", "sent"]),
    ));
    let wait = false;
    for (const candidate of candidates) {
      const decision = reminderBriefingBundleDecision({
        reminderScheduledFor: row.delivery.scheduledFor, briefingScheduledFor: candidate.scheduledFor,
        briefingStatus: candidate.status as "pending" | "processing" | "sent", now,
      });
      if (decision === "suppress") return "suppress";
      if (decision === "wait") wait = true;
    }
    return wait ? "wait" : "none";
  }

  private async scheduleNextCriticalEscalation(row: ReminderDeliveryRow, sentAt: Date): Promise<void> {
    if (row.rule.origin !== "default" || row.rule.purpose !== "follow_up" || row.task.kind !== "task" || row.task.timeMode !== "deadline" || row.task.importance !== "critical" || !row.occurrence) return;
    const dueAt = row.occurrence.dueAt ?? row.task.dueAt;
    if (!dueAt || dueAt > sentAt || !["open", "in_progress"].includes(row.occurrence.status)) return;
    const next = nextCriticalEscalationAt(sentAt, row.settings.criticalPostDueMinutes);
    const deduplicationKey = `${row.rule.id}:${row.occurrence.id}:critical-escalation:${next.toISOString()}`;
    const [created] = await this.database.db.insert(reminderDeliveries).values({
      workspaceId: row.delivery.workspaceId, recipientUserId: row.delivery.recipientUserId, reminderRuleId: row.rule.id,
      taskId: row.task.id, occurrenceId: row.occurrence.id, intendedFor: next, scheduledFor: next, status: "pending", deduplicationKey,
    }).onConflictDoNothing().returning({ id: reminderDeliveries.id });
    if (created) await this.enqueue(created.id, next).catch((error) => {
      console.error("critical escalation enqueue deferred", { deliveryId: created.id, error: safeError(error) });
    });
  }

  private async suppress(deliveryId: string, reason: "access" | "quiet_stale" | "snooze_stale" | "no_longer_applicable" | "superseded"): Promise<void> {
    await this.database.db.update(reminderDeliveries)
      .set({ status: "suppressed", suppressedReason: reason })
      .where(and(eq(reminderDeliveries.id, deliveryId), eq(reminderDeliveries.status, "pending")));
  }
}
