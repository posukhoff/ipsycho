import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { isTerminalOccurrenceStatus } from "../core/types.js";
import { and, asc, eq, gt, gte, inArray, lte, or, sql } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { JobQueueService } from "../queue/job-queue.service.js";
import { briefingDeliveries, reminderDeliveries, reminderRules, taskChecklistItems, taskOccurrences, tasks, users, userSettings, workspaceMembers } from "../database/schema.js";
import { TelegramService } from "../telegram/telegram.service.js";
import { classifyTelegramSendError } from "../telegram/telegram-send-outcome.js";
import { reminderCardText } from "../telegram/telegram-ui.js";
import { telegramLocale } from "../telegram/telegram-locale.js";
import { t } from "../telegram/copy/index.js";
import { occurrenceProjectionFromRow, reminderRuleSpecFromRow, reminderSettingsFromRow, taskDefinitionFromRow } from "../tasks/task-record-mappers.js";
import { applyNotificationPolicy } from "../core/reminder-planning.js";
import { nextCriticalEscalationAt, reminderBriefingBundleDecision } from "../core/reminder-escalation.js";
import { safeError } from "../observability/safe-error.js";
import { logger } from "../observability/logger.js";
import { loopHealth } from "../observability/loop-health.js";

export const REMINDER_QUEUE = "reminder-delivery";
const MAX_DELIVERY_ATTEMPTS = 3;
/** Matches the queue's own retry delay, so the row says when the next attempt is actually due. */
const RETRY_DELAY_MS = 30_000;
const RECONCILE_INTERVAL_MS = 60_000;
/** Boot enqueues everything overdue plus this much of the future; reconciliation covers the rest. */
/** A pending delivery this far past its time was neither sent nor failed: the queue is not draining. */
const STALE_PENDING_MS = 10 * 60_000;
const BOOT_HORIZON_MS = 24 * 60 * 60_000;
const RECONCILE_HORIZON_MS = 2 * 60_000;
const ENQUEUE_BATCH = 1000;

type ReminderDeliveryRow = {
  delivery: typeof reminderDeliveries.$inferSelect;
  rule: typeof reminderRules.$inferSelect;
  settings: typeof userSettings.$inferSelect;
  task: typeof tasks.$inferSelect;
  occurrence: typeof taskOccurrences.$inferSelect | null;
  telegramUserId: number;
  userStatus: (typeof users.$inferSelect)["status"];
};

@Injectable()
export class ReminderQueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private reconcileTimer?: NodeJS.Timeout;
  lastTickAt: Date | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly telegram: TelegramService,
    private readonly queue: JobQueueService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    loopHealth.register("reminder_reconcile", RECONCILE_INTERVAL_MS);
    await this.queue.ensureQueue(REMINDER_QUEUE, { retryLimit: MAX_DELIVERY_ATTEMPTS - 1, retryDelaySeconds: RETRY_DELAY_MS / 1000 });
    // Boot recovery runs before the worker starts. Rows left in `processing` by a previous
    // process are reset first; if the worker were already consuming, it could claim a row
    // between the reset and its own post-send update and the row would be sent twice.
    await this.database.db.update(reminderDeliveries).set({ status: "pending" }).where(eq(reminderDeliveries.status, "processing"));
    await this.enqueuePending(new Date(Date.now() + BOOT_HORIZON_MS));
    await this.queue.work<{ deliveryId: string }>(REMINDER_QUEUE, (data) => this.deliver(data.deliveryId));
    // Periodic reconciliation never touches in-flight work; it only repairs pending rows
    // whose queue job was lost (a failed enqueue, an expired job).
    this.reconcileTimer = setInterval(
      () => void this.reconcile().catch((error) => logger.error("reminder queue reconciliation failed", { error: safeError(error) })),
      RECONCILE_INTERVAL_MS,
    );
    this.reconcileTimer.unref();
  }

  onApplicationShutdown(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
  }

  /** Queue depth for /status: what is waiting and what could not be confirmed as delivered. */
  async queueSummary(now = new Date()): Promise<{ pending: number; stalePending: number; ambiguous: number; deadLettered: number }> {
    const staleBefore = new Date(now.getTime() - STALE_PENDING_MS);
    const [row] = await this.database.db
      .select({
        pending: sql<number>`count(*) filter (where ${reminderDeliveries.status} = 'pending')::int`,
        stalePending: sql<number>`count(*) filter (where ${reminderDeliveries.status} = 'pending' and ${reminderDeliveries.scheduledFor} < ${staleBefore})::int`,
        ambiguous: sql<number>`count(*) filter (where ${reminderDeliveries.status} = 'ambiguous')::int`,
      })
      .from(reminderDeliveries);
    const deadLettered = await this.queue.deadLetterCount(REMINDER_QUEUE).catch(() => 0);
    return { pending: row?.pending ?? 0, stalePending: row?.stalePending ?? 0, ambiguous: row?.ambiguous ?? 0, deadLettered };
  }

  async reconcile(now = new Date()): Promise<void> {
    await this.enqueuePending(new Date(now.getTime() + RECONCILE_HORIZON_MS));
    this.lastTickAt = now;
    loopHealth.beat("reminder_reconcile", now.getTime());
  }

  async enqueue(deliveryId: string, scheduledFor: Date): Promise<void> {
    const startAfter = scheduledFor > new Date() ? scheduledFor : new Date();
    await this.queue.send(
      REMINDER_QUEUE,
      { deliveryId },
      {
        startAfter,
        singletonKey: `${deliveryId}:${scheduledFor.toISOString()}`,
      },
    );
  }

  /** Walks every pending delivery due before `horizon` in (scheduled_for, id) order; no row is skipped past the batch size. */
  private async enqueuePending(horizon: Date): Promise<void> {
    let after: { scheduledFor: Date; id: string } | null = null;
    for (;;) {
      const cursor: { scheduledFor: Date; id: string } | null = after;
      const keyset = cursor
        ? or(gt(reminderDeliveries.scheduledFor, cursor.scheduledFor), and(eq(reminderDeliveries.scheduledFor, cursor.scheduledFor), gt(reminderDeliveries.id, cursor.id)))
        : undefined;
      const pending: Array<{ id: string; scheduledFor: Date }> = await this.database.db
        .select({
          id: reminderDeliveries.id,
          scheduledFor: reminderDeliveries.scheduledFor,
        })
        .from(reminderDeliveries)
        .where(and(eq(reminderDeliveries.status, "pending"), lte(reminderDeliveries.scheduledFor, horizon), keyset))
        .orderBy(asc(reminderDeliveries.scheduledFor), asc(reminderDeliveries.id))
        .limit(ENQUEUE_BATCH);
      for (const delivery of pending) {
        try {
          await this.enqueue(delivery.id, delivery.scheduledFor);
        } catch (error) {
          logger.error("failed to reconcile reminder", { deliveryId: delivery.id, error: safeError(error) });
        }
      }
      const last = pending[pending.length - 1];
      if (pending.length < ENQUEUE_BATCH || !last) return;
      after = last;
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
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, reminderDeliveries.workspaceId), eq(workspaceMembers.userId, reminderDeliveries.recipientUserId)))
      .innerJoin(tasks, and(eq(tasks.workspaceId, reminderDeliveries.workspaceId), eq(tasks.id, reminderDeliveries.taskId)))
      .innerJoin(reminderRules, and(eq(reminderRules.workspaceId, reminderDeliveries.workspaceId), eq(reminderRules.id, reminderDeliveries.reminderRuleId)))
      .innerJoin(userSettings, eq(userSettings.userId, reminderDeliveries.recipientUserId))
      .leftJoin(taskOccurrences, and(eq(taskOccurrences.workspaceId, reminderDeliveries.workspaceId), eq(taskOccurrences.id, reminderDeliveries.occurrenceId)))
      .where(eq(reminderDeliveries.id, deliveryId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      // The delivery lost its user, task or rule (or never matched the join). Left as pending it
      // would be re-enqueued on every reconciliation forever.
      await this.suppress(deliveryId, "orphaned");
      return;
    }
    if (row.delivery.status !== "pending") return;

    if (row.userStatus !== "active") {
      await this.suppress(deliveryId, "access");
      return;
    }
    const terminalOccurrence = Boolean(row.occurrence?.status && isTerminalOccurrenceStatus(row.occurrence.status));
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
      // A delivery that already failed to send is retried a minute or two later, and it must not be
      // discarded as stale for the time those attempts took: relevance was judged on the first one.
      attempted: row.delivery.attempts > 0,
    });
    if (policy.suppressedReason) {
      logger.warn("reminder suppressed by delivery-time policy", {
        deliveryId,
        taskId: row.task.id,
        occurrenceId: row.occurrence?.id ?? null,
        intendedFor: row.delivery.intendedFor.toISOString(),
        evaluatedAt: now.toISOString(),
        // Both, because staleness is judged against the deferred moment while the bound on reviving
        // an old contact is judged against the intended one.
        latenessFromIntendedMs: now.getTime() - row.delivery.intendedFor.getTime(),
        latenessFromScheduledMs: now.getTime() - policy.scheduledFor.getTime(),
        reason: policy.suppressedReason,
      });
      await this.suppress(deliveryId, policy.suppressedReason);
      return;
    }
    if (policy.scheduledFor.getTime() > now.getTime() + 500) {
      await this.database.db
        .update(reminderDeliveries)
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
    const [claimed] = await this.database.db
      .update(reminderDeliveries)
      .set({ status: "processing", attempts: nextAttempt })
      .where(and(eq(reminderDeliveries.id, deliveryId), eq(reminderDeliveries.status, "pending")))
      .returning();
    if (!claimed) return;

    try {
      const checklist = await this.database.db
        .select({ text: taskChecklistItems.text, done: taskChecklistItems.done })
        .from(taskChecklistItems)
        .where(and(eq(taskChecklistItems.workspaceId, row.task.workspaceId), eq(taskChecklistItems.taskId, row.task.id)))
        .orderBy(taskChecklistItems.sortOrder)
        .catch(() => []);
      const locale = telegramLocale(row.settings.pinnedLanguage, row.settings.telegramLanguage ?? undefined);
      // A reminder pushed out of quiet hours says so; an escalation says which one it is and offers to stop.
      const deferredByQuiet = row.settings.quietHoursEnabled && row.delivery.scheduledFor.getTime() - row.delivery.intendedFor.getTime() > 60_000;
      const escalation = isCriticalEscalation(row) ? await this.escalationNumber(row) : 0;
      const header =
        [...(deferredByQuiet ? [t(locale, "quiet_deferred_notice")] : []), ...(escalation >= 2 ? [t(locale, "escalation_header", { n: escalation })] : [])].join("\n") || null;
      const text = reminderCardText({
        task: { ...row.task, checklist },
        occurrence: row.occurrence,
        purpose: row.rule.purpose,
        now,
        locale,
        header,
      });
      const telegramMessageId = await this.telegram.sendReminder(row.telegramUserId, text, row.delivery.occurrenceId ?? undefined, locale, {
        mute: escalation >= 2,
      });
      const sentAt = new Date();
      await this.database.db
        .update(reminderDeliveries)
        .set({ status: "sent", sentAt, telegramMessageId })
        .where(and(eq(reminderDeliveries.id, deliveryId), eq(reminderDeliveries.status, "processing")));
      await this.scheduleNextCriticalEscalation(row, sentAt);
    } catch (error) {
      await this.recordSendFailure(deliveryId, row.delivery.attempts, nextAttempt, error);
    }
  }

  /**
   * Telegram delivery is a non-transactional side effect. Only a failure that provably never
   * reached Telegram is retried; a timeout after the request left the process may already have
   * produced a message, so it is recorded as ambiguous and never resent automatically.
   * A concurrent reschedule/cancel may move a processing delivery to cancelled while the send is
   * in flight; every update below is guarded by `status = 'processing'` so it is never revived.
   */
  private async recordSendFailure(deliveryId: string, previousAttempts: number, nextAttempt: number, error: unknown): Promise<void> {
    const processing = and(eq(reminderDeliveries.id, deliveryId), eq(reminderDeliveries.status, "processing"));
    const outcome = classifyTelegramSendError(error);
    switch (outcome.kind) {
      case "rate_limited": {
        const retryAt = new Date(Date.now() + outcome.retryAfterSeconds * 1000);
        await this.database.db.update(reminderDeliveries).set({ status: "pending", attempts: previousAttempts, scheduledFor: retryAt }).where(processing);
        await this.enqueue(deliveryId, retryAt);
        return;
      }
      case "rejected":
        logger.warn("reminder rejected by Telegram", { deliveryId, errorCode: outcome.errorCode });
        await this.database.db.update(reminderDeliveries).set({ status: "failed" }).where(processing);
        return;
      case "ambiguous":
        logger.warn("reminder send outcome ambiguous", { deliveryId, error: safeError(error) });
        await this.database.db.update(reminderDeliveries).set({ status: "ambiguous", sentAt: new Date() }).where(processing);
        return;
      default:
        await this.database.db
          .update(reminderDeliveries)
          .set({ status: nextAttempt >= MAX_DELIVERY_ATTEMPTS ? "failed" : "pending" })
          .where(processing);
        throw error;
    }
  }

  private async bundleWithBriefing(row: ReminderDeliveryRow, now: Date): Promise<"none" | "wait" | "suppress"> {
    if (row.rule.origin !== "default" || row.task.timeMode !== "deadline" || row.task.importance === "normal") return "none";
    const lower = new Date(row.delivery.scheduledFor.getTime() - 60_000);
    const upper = new Date(row.delivery.scheduledFor.getTime() + 60_000);
    const candidates = await this.database.db
      .select({
        scheduledFor: briefingDeliveries.scheduledFor,
        status: briefingDeliveries.status,
      })
      .from(briefingDeliveries)
      .where(
        and(
          eq(briefingDeliveries.workspaceId, row.delivery.workspaceId),
          eq(briefingDeliveries.recipientUserId, row.delivery.recipientUserId),
          gte(briefingDeliveries.scheduledFor, lower),
          lte(briefingDeliveries.scheduledFor, upper),
          inArray(briefingDeliveries.status, ["pending", "processing", "sent", "ambiguous"]),
        ),
      );
    let wait = false;
    for (const candidate of candidates) {
      const decision = reminderBriefingBundleDecision({
        reminderScheduledFor: row.delivery.scheduledFor,
        briefingScheduledFor: candidate.scheduledFor,
        briefingStatus: candidate.status as "pending" | "processing" | "sent" | "ambiguous",
        now,
      });
      if (decision === "suppress") return "suppress";
      if (decision === "wait") wait = true;
    }
    return wait ? "wait" : "none";
  }

  /** How many deliveries of this critical rule already reached the user for this occurrence, plus the one being sent. */
  private async escalationNumber(row: ReminderDeliveryRow): Promise<number> {
    if (!row.occurrence) return 0;
    const [count] = await this.database.db
      .select({ sent: sql<number>`count(*)::int` })
      .from(reminderDeliveries)
      .where(
        and(
          eq(reminderDeliveries.workspaceId, row.delivery.workspaceId),
          eq(reminderDeliveries.reminderRuleId, row.rule.id),
          eq(reminderDeliveries.occurrenceId, row.occurrence.id),
          inArray(reminderDeliveries.status, ["sent", "ambiguous"]),
        ),
      );
    return (count?.sent ?? 0) + 1;
  }

  private async scheduleNextCriticalEscalation(row: ReminderDeliveryRow, sentAt: Date): Promise<void> {
    if (
      row.rule.origin !== "default" ||
      row.rule.purpose !== "follow_up" ||
      row.task.kind !== "task" ||
      row.task.timeMode !== "deadline" ||
      row.task.importance !== "critical" ||
      !row.occurrence
    )
      return;
    const dueAt = row.occurrence.dueAt ?? row.task.dueAt;
    if (!dueAt || dueAt > sentAt || !["open", "in_progress"].includes(row.occurrence.status)) return;
    const next = nextCriticalEscalationAt(sentAt, row.settings.criticalPostDueMinutes);
    const deduplicationKey = `${row.rule.id}:${row.occurrence.id}:critical-escalation:${next.toISOString()}`;
    const [created] = await this.database.db
      .insert(reminderDeliveries)
      .values({
        workspaceId: row.delivery.workspaceId,
        recipientUserId: row.delivery.recipientUserId,
        reminderRuleId: row.rule.id,
        taskId: row.task.id,
        occurrenceId: row.occurrence.id,
        intendedFor: next,
        scheduledFor: next,
        status: "pending",
        deduplicationKey,
      })
      .onConflictDoNothing()
      .returning({ id: reminderDeliveries.id });
    if (created)
      await this.enqueue(created.id, next).catch((error) => {
        logger.error("critical escalation enqueue deferred", { deliveryId: created.id, error: safeError(error) });
      });
  }

  private async suppress(deliveryId: string, reason: "access" | "quiet_stale" | "snooze_stale" | "no_longer_applicable" | "superseded" | "orphaned"): Promise<void> {
    await this.database.db
      .update(reminderDeliveries)
      .set({ status: "suppressed", suppressedReason: reason })
      .where(and(eq(reminderDeliveries.id, deliveryId), eq(reminderDeliveries.status, "pending")));
  }
}

function isCriticalEscalation(row: ReminderDeliveryRow): boolean {
  return (
    row.rule.origin === "default" &&
    row.rule.purpose === "follow_up" &&
    row.task.kind === "task" &&
    row.task.timeMode === "deadline" &&
    row.task.importance === "critical" &&
    Boolean(row.occurrence)
  );
}
