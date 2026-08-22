import { randomUUID } from "node:crypto";
import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { planReminders } from "../core/reminder-planning.js";
import { buildRecurringOccurrences } from "../core/recurrence.js";
import { DatabaseService } from "../database/database.service.js";
import { reminderDeliveries, reminderRules, taskOccurrences, taskRecurrenceExclusions, tasks, userSettings, workspaces } from "../database/schema.js";
import { reminderRuleSpecFromRow, reminderSettingsFromRow, taskDefinitionFromRow } from "./task-record-mappers.js";
import { ReminderQueueService } from "../reminders/reminder-queue.service.js";
import { safeError } from "../observability/safe-error.js";

const REFILL_INTERVAL_MS = 6 * 60 * 60_000;

@Injectable()
export class RecurrenceMaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly queue: ReminderQueueService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.refill();
    this.timer = setInterval(() => void this.refill().catch((error) => console.error("recurrence refill tick failed", safeError(error))), REFILL_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refill(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const rows = await this.database.db
        .select({ task: tasks, recipientUserId: workspaces.ownerUserId, settings: userSettings })
        .from(tasks)
        .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
        .innerJoin(userSettings, eq(userSettings.userId, workspaces.ownerUserId))
        .where(and(eq(tasks.status, "active"), isNotNull(tasks.recurrenceRule)))
        .limit(500);

      for (const row of rows) {
        try {
          await this.refillTask(row.task, row.recipientUserId, row.settings, now);
        } catch (error) {
          console.error("recurrence refill failed", { taskId: row.task.id, error: safeError(error) });
        }
      }
    } finally {
      this.running = false;
    }
  }

  async reconcileTask(workspaceId: string, taskId: string, now = new Date()): Promise<void> {
    const [row] = await this.database.db
      .select({ task: tasks, recipientUserId: workspaces.ownerUserId, settings: userSettings })
      .from(tasks)
      .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
      .innerJoin(userSettings, eq(userSettings.userId, workspaces.ownerUserId))
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId), eq(tasks.status, "active"), isNotNull(tasks.recurrenceRule)))
      .limit(1);
    if (row) await this.refillTask(row.task, row.recipientUserId, row.settings, now);
  }

  async refillTask(
    taskRow: typeof tasks.$inferSelect,
    recipientUserId: string,
    settingsRow: typeof userSettings.$inferSelect,
    now: Date,
  ): Promise<void> {
    const exclusions = await this.database.db.select({ localDate: taskRecurrenceExclusions.localDate })
      .from(taskRecurrenceExclusions)
      .where(and(
        eq(taskRecurrenceExclusions.workspaceId, taskRow.workspaceId),
        eq(taskRecurrenceExclusions.taskId, taskRow.id),
      ));
    const definition = taskDefinitionFromRow(taskRow, exclusions.map((row) => row.localDate));
    const projections = buildRecurringOccurrences(definition, now);
    if (!projections.length) return;

    const existing = await this.database.db.select({ recurrenceKey: taskOccurrences.recurrenceKey })
      .from(taskOccurrences)
      .where(and(
        eq(taskOccurrences.workspaceId, taskRow.workspaceId),
        eq(taskOccurrences.taskId, taskRow.id),
        eq(taskOccurrences.seriesRevision, taskRow.seriesRevision),
      ));
    const existingKeys = new Set(existing.flatMap((row) => row.recurrenceKey ? [row.recurrenceKey] : []));
    const missing = projections.filter((projection) => projection.recurrenceKey && !existingKeys.has(projection.recurrenceKey));
    if (!missing.length) return;

    const rules = await this.database.db.select().from(reminderRules).where(and(
      eq(reminderRules.workspaceId, taskRow.workspaceId),
      eq(reminderRules.taskId, taskRow.id),
      eq(reminderRules.active, true),
      isNull(reminderRules.occurrenceId),
    ));
    const ruleSpecs = rules.map(reminderRuleSpecFromRow);
    const settings = reminderSettingsFromRow(settingsRow);

    const occurrenceRows: Array<typeof taskOccurrences.$inferInsert> = [];
    const deliveryRows: Array<typeof reminderDeliveries.$inferInsert> = [];

    for (const projection of missing) {
      const occurrenceId = randomUUID();
      occurrenceRows.push({
        id: occurrenceId,
        workspaceId: taskRow.workspaceId,
        taskId: taskRow.id,
        recurrenceKey: projection.recurrenceKey,
        seriesRevision: taskRow.seriesRevision,
        status: projection.status,
        timezone: projection.timezone,
        ...(projection.plannedStartAt ? { plannedStartAt: projection.plannedStartAt } : {}),
        ...(projection.plannedEndAt ? { plannedEndAt: projection.plannedEndAt } : {}),
        ...(projection.plannedLocalDate ? { plannedLocalDate: projection.plannedLocalDate } : {}),
        ...(projection.dueAt ? { dueAt: projection.dueAt } : {}),
        ...(projection.dueLocalDate ? { dueLocalDate: projection.dueLocalDate } : {}),
        ...(projection.expiresAt ? { expiresAt: projection.expiresAt } : {}),
        dstAdjusted: projection.dstAdjusted ?? false,
      });

      const plans = planReminders({ task: definition, occurrence: projection, rules: ruleSpecs, settings, now });
      for (const plan of plans) {
        const rule = rules[plan.ruleIndex];
        if (!rule) throw new Error("reminder rule index is invalid");
        const deliveryId = randomUUID();
        deliveryRows.push({
          id: deliveryId,
          workspaceId: taskRow.workspaceId,
          recipientUserId,
          reminderRuleId: rule.id,
          taskId: taskRow.id,
          occurrenceId,
          intendedFor: plan.intendedFor,
          scheduledFor: plan.scheduledFor,
          status: plan.suppressedReason ? "suppressed" : "pending",
          ...(plan.suppressedReason ? { suppressedReason: plan.suppressedReason } : {}),
          deduplicationKey: `${rule.id}:${occurrenceId}:${plan.intendedFor.toISOString()}`,
        });
      }
    }

    await this.database.db.transaction(async (tx) => {
      if (occurrenceRows.length) await tx.insert(taskOccurrences).values(occurrenceRows);
      if (deliveryRows.length) await tx.insert(reminderDeliveries).values(deliveryRows);
    });

    for (const delivery of deliveryRows) {
      if (delivery.status !== "pending" || !delivery.id) continue;
      try {
        await this.queue.enqueue(delivery.id, delivery.scheduledFor);
      } catch (error) {
        console.error("failed to enqueue refilled reminder; queue reconciliation will retry", { deliveryId: delivery.id, error: safeError(error) });
      }
    }
  }
}
