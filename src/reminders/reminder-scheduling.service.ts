import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { seenFollowUpMinutes } from "../core/reminder-defaults.js";
import { isQuietAt } from "../core/quiet-hours.js";
import { applyNotificationPolicy, planReminders, resolveReminderIntent, type ReminderRuleSpec } from "../core/reminder-planning.js";
import { resultCheckDelayMinutes, type ResultCheckChoice } from "../core/result-check.js";
import { localDateAndTimeToUtc, localDateAt, shiftLocalDate } from "../core/timezone.js";
import { DatabaseService } from "../database/database.service.js";
import {
  reminderDeliveries,
  reminderRules,
  taskEvents,
  taskOccurrences,
  tasks,
  userSettings,
  workspaceMembers,
  workspaces,
} from "../database/schema.js";
import {
  occurrenceProjectionFromRow,
  reminderRuleSpecFromRow,
  reminderSettingsFromRow,
  taskDefinitionFromRow,
} from "../tasks/task-record-mappers.js";
import { ReminderQueueService } from "./reminder-queue.service.js";
import { safeError } from "../observability/safe-error.js";

export type FollowUpChoice = ResultCheckChoice | "custom";

@Injectable()
export class ReminderSchedulingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly queue: ReminderQueueService,
  ) {}

  async listUpcoming(input: { workspaceId: string; userId: string; now?: Date; limit?: number }) {
    return this.database.db.select({ delivery: reminderDeliveries, task: tasks, occurrence: taskOccurrences })
      .from(reminderDeliveries)
      .innerJoin(tasks, and(eq(tasks.workspaceId, reminderDeliveries.workspaceId), eq(tasks.id, reminderDeliveries.taskId)))
      .leftJoin(taskOccurrences, and(eq(taskOccurrences.workspaceId, reminderDeliveries.workspaceId), eq(taskOccurrences.id, reminderDeliveries.occurrenceId)))
      .where(and(
        eq(reminderDeliveries.workspaceId, input.workspaceId),
        eq(reminderDeliveries.recipientUserId, input.userId),
        eq(reminderDeliveries.status, "pending"),
        gt(reminderDeliveries.scheduledFor, input.now ?? new Date()),
      ))
      .orderBy(asc(reminderDeliveries.scheduledFor))
      .limit(input.limit ?? 12);
  }

  async cancelUpcoming(input: { workspaceId: string; userId: string; deliveryId: string }): Promise<boolean> {
    const [cancelled] = await this.database.db.update(reminderDeliveries).set({ status: "cancelled", suppressedReason: "superseded" })
      .where(and(
        eq(reminderDeliveries.workspaceId, input.workspaceId),
        eq(reminderDeliveries.recipientUserId, input.userId),
        eq(reminderDeliveries.id, input.deliveryId),
        eq(reminderDeliveries.status, "pending"),
      ))
      .returning({ id: reminderDeliveries.id });
    return Boolean(cancelled);
  }

  /** The user asked the escalation to stop: default reminders for this occurrence are off and their pending deliveries withdrawn. */
  async muteDefaultReminders(input: { workspaceId: string; userId: string; occurrenceId: string }): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx.update(taskOccurrences).set({ defaultRemindersSuppressed: true })
        .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, input.occurrenceId)));
      const defaultRules = await tx.select({ id: reminderRules.id }).from(reminderRules)
        .where(and(eq(reminderRules.workspaceId, input.workspaceId), eq(reminderRules.origin, "default"), sql`(${reminderRules.occurrenceId} IS NULL OR ${reminderRules.occurrenceId} = ${input.occurrenceId})`));
      if (!defaultRules.length) return;
      await tx.update(reminderDeliveries).set({ status: "suppressed", suppressedReason: "user_cancelled" })
        .where(and(
          eq(reminderDeliveries.workspaceId, input.workspaceId),
          eq(reminderDeliveries.recipientUserId, input.userId),
          eq(reminderDeliveries.occurrenceId, input.occurrenceId),
          inArray(reminderDeliveries.reminderRuleId, defaultRules.map((rule) => rule.id)),
          inArray(reminderDeliveries.status, ["pending", "processing"]),
        ));
    });
  }

  async scheduleSeenFallback(input: { workspaceId: string; userId: string; occurrenceId: string; now?: Date }): Promise<string | null> {
    const row = await this.getOccurrenceSettings(input.workspaceId, input.userId, input.occurrenceId);
    if (isTerminal(row.occurrence.status)) return null;
    const now = input.now ?? new Date();
    const minutes = seenFollowUpMinutes(row.task.importance, {
      seenNormalMinutes: row.settings.seenNormalMinutes,
      seenRequiredMinutes: row.settings.seenRequiredMinutes,
      seenCriticalMinutes: row.settings.seenCriticalMinutes,
    });
    return this.scheduleSystemFollowUp({ ...input, intendedFor: new Date(now.getTime() + minutes * 60_000), now });
  }

  async scheduleFollowUpChoice(input: {
    workspaceId: string;
    userId: string;
    occurrenceId: string;
    choice: Exclude<FollowUpChoice, "custom">;
    mode: "seen" | "result";
    now?: Date;
  }): Promise<string | null> {
    const row = await this.getOccurrenceSettings(input.workspaceId, input.userId, input.occurrenceId);
    if (isTerminal(row.occurrence.status)) return null;
    const now = input.now ?? new Date();
    const intendedFor = input.choice === "evening"
      ? nextReferenceTime(now, row.settings.timezone, row.settings.eveningReferenceTime)
      : new Date(now.getTime() + resultCheckDelayMinutes(input.choice) * 60_000);
    if (input.mode === "result" && row.occurrence.status !== "in_progress") throw new Error("result check requires an in-progress occurrence");
    return this.scheduleSystemFollowUp({ ...input, intendedFor, now });
  }

  async scheduleCustomFollowUp(input: {
    workspaceId: string;
    userId: string;
    occurrenceId: string;
    intendedFor: Date;
    mode: "seen" | "result";
    now?: Date;
  }): Promise<string | null> {
    const row = await this.getOccurrenceSettings(input.workspaceId, input.userId, input.occurrenceId);
    if (isTerminal(row.occurrence.status)) return null;
    if (input.intendedFor <= (input.now ?? new Date())) throw new Error("follow-up must be in the future");
    if (input.mode === "result" && row.occurrence.status !== "in_progress") throw new Error("result check requires an in-progress occurrence");
    return this.scheduleSystemFollowUp({ ...input, now: input.now ?? new Date() });
  }

  async validateExplicitReminderChange(input: {
    workspaceId: string;
    userId: string;
    occurrenceId: string;
    mode: "add" | "replace" | "clear";
    rule?: ReminderRuleSpec;
    now?: Date;
  }): Promise<void> {
    if (input.mode === "clear") return;
    if (!input.rule) throw new Error("reminder rule is required");
    const row = await this.getOccurrenceSettings(input.workspaceId, input.userId, input.occurrenceId);
    const task = taskDefinitionFromRow(row.task);
    const occurrence = occurrenceProjectionFromRow(row.occurrence);
    const intendedFor = resolveReminderIntent(input.rule, task, occurrence, occurrence.timezone);
    if (intendedFor <= (input.now ?? new Date())) throw new Error("reminder must be in the future");
    if (input.rule.quietPolicy === "respect" && row.settings.quietHoursEnabled && isQuietAt(intendedFor, row.settings.quietHoursTimezone, {
      enabled: true,
      weekday: { start: row.settings.weekdayQuietStart, end: row.settings.weekdayQuietEnd },
      weekend: { start: row.settings.weekendQuietStart, end: row.settings.weekendQuietEnd },
    })) {
      throw new Error("reminder falls inside quiet hours; ask whether to send exactly, delay until quiet hours end, or choose another time");
    }
    if (input.mode !== "add") return;

    const existing = await this.database.db.select().from(reminderRules).where(and(
      eq(reminderRules.workspaceId, input.workspaceId),
      eq(reminderRules.occurrenceId, input.occurrenceId),
      eq(reminderRules.origin, "explicit"),
      eq(reminderRules.active, true),
    ));
    for (const current of existing) {
      const currentIntent = resolveReminderIntent(reminderRuleSpecFromRow(current), task, occurrence, occurrence.timezone);
      if (Math.abs(currentIntent.getTime() - intendedFor.getTime()) < 15 * 60_000) {
        throw new Error("two explicit reminders are closer than 15 minutes; choose one time or replace the existing reminder");
      }
    }
  }

  async reconcileFuzzyReviews(now = new Date(), limit = 200): Promise<number> {
    const rows = await this.database.db
      .select({ workspaceId: tasks.workspaceId, taskId: tasks.id, userId: workspaces.ownerUserId })
      .from(tasks)
      .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
      .where(and(
        eq(tasks.status, "active"),
        eq(tasks.timeMode, "fuzzy"),
        sql`${tasks.reviewAt} IS NOT NULL`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${reminderRules} rr
          WHERE rr.workspace_id = ${tasks.workspaceId}
            AND rr.task_id = ${tasks.id}
            AND rr.occurrence_id IS NULL
            AND rr.purpose = 'planning_review'
            AND rr.origin = 'default'
            AND rr.active = true
        )`,
      ))
      .limit(limit);
    let rebuilt = 0;
    for (const row of rows) {
      rebuilt += await this.rebuildFuzzyTask(row.workspaceId, row.userId, row.taskId, now).catch(() => 0);
    }
    return rebuilt;
  }

  async rebuildFuzzyTask(workspaceId: string, userId: string, taskId: string, now = new Date()): Promise<number> {
    const [row] = await this.database.db
      .select({ task: tasks, settings: userSettings })
      .from(tasks)
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, tasks.workspaceId), eq(workspaceMembers.userId, userId)))
      .innerJoin(userSettings, eq(userSettings.userId, workspaceMembers.userId))
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)))
      .limit(1);
    if (!row) throw new Error("task not found");

    const existing = await this.database.db.select({ id: reminderRules.id }).from(reminderRules).where(and(
      eq(reminderRules.workspaceId, workspaceId),
      eq(reminderRules.taskId, taskId),
      sql`${reminderRules.occurrenceId} IS NULL`,
      eq(reminderRules.purpose, "planning_review"),
      eq(reminderRules.origin, "default"),
      eq(reminderRules.active, true),
    ));
    const existingIds = existing.map((item) => item.id);
    const shouldSchedule = row.task.status === "active" && row.task.timeMode === "fuzzy" && Boolean(row.task.reviewAt);
    const created = await this.database.db.transaction(async (tx): Promise<typeof reminderDeliveries.$inferInsert | null> => {
      if (existingIds.length) {
        await tx.update(reminderDeliveries).set({ status: "cancelled", suppressedReason: "superseded" }).where(and(
          eq(reminderDeliveries.workspaceId, workspaceId),
          inArray(reminderDeliveries.reminderRuleId, existingIds),
          inArray(reminderDeliveries.status, ["pending", "processing"]),
        ));
        await tx.update(reminderRules).set({ active: false }).where(and(eq(reminderRules.workspaceId, workspaceId), inArray(reminderRules.id, existingIds)));
      }
      if (!shouldSchedule) return null;

      const rule: ReminderRuleSpec = {
        triggerKind: "relative_timestamp",
        anchor: "review_at",
        offsetSeconds: 0,
        purpose: "planning_review",
        quietPolicy: "respect",
        origin: "default",
      };
      const task = taskDefinitionFromRow(row.task);
      const intendedFor = resolveReminderIntent(rule, task, null, task.timezone);
      const policy = applyNotificationPolicy({
        intendedFor, now, task, occurrence: null, rule, settings: reminderSettingsFromRow(row.settings),
      });
      const ruleId = randomUUID();
      const deliveryId = randomUUID();
      await tx.insert(reminderRules).values({
        id: ruleId, workspaceId, taskId, triggerKind: rule.triggerKind, anchor: "review_at", offsetSeconds: 0,
        purpose: "planning_review", quietPolicy: "respect", origin: "default", active: true,
      });
      const delivery: typeof reminderDeliveries.$inferInsert = {
        id: deliveryId,
        workspaceId,
        recipientUserId: userId,
        reminderRuleId: ruleId,
        taskId,
        intendedFor,
        scheduledFor: policy.scheduledFor,
        status: policy.suppressedReason ? "suppressed" : "pending",
        ...(policy.suppressedReason ? { suppressedReason: policy.suppressedReason } : {}),
        deduplicationKey: `${ruleId}:task:${intendedFor.toISOString()}`,
      };
      await tx.insert(reminderDeliveries).values(delivery);
      return delivery;
    });

    if (created?.status === "pending" && created.id && created.scheduledFor) {
      await this.queue.enqueue(created.id, created.scheduledFor).catch((error) => {
        console.error("failed to enqueue planning review; reconciliation will retry", { deliveryId: created?.id, error: safeError(error) });
      });
      return 1;
    }
    return 0;
  }

  /** Earliest pending user-facing reminder of one occurrence; what the user will actually receive next. */
  async nextUserReminderAt(workspaceId: string, occurrenceId: string): Promise<Date | null> {
    const [row] = await this.database.db
      .select({ scheduledFor: reminderDeliveries.scheduledFor })
      .from(reminderDeliveries)
      .innerJoin(reminderRules, and(eq(reminderRules.workspaceId, reminderDeliveries.workspaceId), eq(reminderRules.id, reminderDeliveries.reminderRuleId)))
      .where(and(
        eq(reminderDeliveries.workspaceId, workspaceId),
        eq(reminderDeliveries.occurrenceId, occurrenceId),
        eq(reminderDeliveries.status, "pending"),
        eq(reminderRules.purpose, "user_reminder"),
      ))
      .orderBy(reminderDeliveries.scheduledFor)
      .limit(1);
    return row?.scheduledFor ?? null;
  }

  async rebuildOccurrence(workspaceId: string, occurrenceId: string, now = new Date()): Promise<number> {
    const [row] = await this.database.db
      .select({ task: tasks, occurrence: taskOccurrences, recipientUserId: workspaces.ownerUserId, settings: userSettings })
      .from(taskOccurrences)
      .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
      .innerJoin(workspaces, eq(workspaces.id, taskOccurrences.workspaceId))
      .innerJoin(userSettings, eq(userSettings.userId, workspaces.ownerUserId))
      .where(and(eq(taskOccurrences.workspaceId, workspaceId), eq(taskOccurrences.id, occurrenceId)))
      .limit(1);
    if (!row) throw new Error("occurrence not found");

    if (isTerminal(row.occurrence.status) || row.task.status !== "active") {
      await this.database.db.update(taskOccurrences).set({ needsReminderRebuild: false }).where(and(
        eq(taskOccurrences.workspaceId, workspaceId),
        eq(taskOccurrences.id, occurrenceId),
      ));
      return 0;
    }

    const rules = await this.database.db.select().from(reminderRules).where(and(
      eq(reminderRules.workspaceId, workspaceId),
      eq(reminderRules.taskId, row.task.id),
      eq(reminderRules.active, true),
      sql`(${reminderRules.occurrenceId} IS NULL OR ${reminderRules.occurrenceId} = ${occurrenceId})`,
    ));
    const applicableRules = row.occurrence.defaultRemindersSuppressed
      ? rules.filter((rule) => rule.origin !== "default")
      : rules;
    const plans = planReminders({
      task: taskDefinitionFromRow(row.task),
      occurrence: occurrenceProjectionFromRow(row.occurrence),
      rules: applicableRules.map(reminderRuleSpecFromRow),
      settings: reminderSettingsFromRow(row.settings),
      now,
    });

    const created: Array<typeof reminderDeliveries.$inferInsert> = [];
    await this.database.db.transaction(async (tx) => {
      await tx.update(reminderDeliveries).set({ status: "cancelled", suppressedReason: "superseded" }).where(and(
        eq(reminderDeliveries.workspaceId, workspaceId),
        eq(reminderDeliveries.occurrenceId, occurrenceId),
        inArray(reminderDeliveries.status, ["pending", "processing"]),
      ));
      for (const plan of plans) {
        const rule = applicableRules[plan.ruleIndex];
        if (!rule) throw new Error("reminder rule index is invalid");
        const id = randomUUID();
        created.push({
          id,
          workspaceId,
          recipientUserId: row.recipientUserId,
          reminderRuleId: rule.id,
          taskId: row.task.id,
          occurrenceId,
          intendedFor: plan.intendedFor,
          scheduledFor: plan.scheduledFor,
          status: plan.suppressedReason ? "suppressed" : "pending",
          ...(plan.suppressedReason ? { suppressedReason: plan.suppressedReason } : {}),
          deduplicationKey: `${rule.id}:${occurrenceId}:v${row.occurrence.version}:${plan.intendedFor.toISOString()}`,
        });
      }
      if (created.length) await tx.insert(reminderDeliveries).values(created);
      await tx.update(taskOccurrences).set({ needsReminderRebuild: false }).where(and(
        eq(taskOccurrences.workspaceId, workspaceId), eq(taskOccurrences.id, occurrenceId),
      ));
    });
    await this.enqueueCreated(created, "rebuilt reminder");
    return created.length;
  }

  private async scheduleSystemFollowUp(input: {
    workspaceId: string;
    userId: string;
    occurrenceId: string;
    intendedFor: Date;
    now: Date;
    mode?: "seen" | "result";
  }): Promise<string> {
    const row = await this.getOccurrenceSettings(input.workspaceId, input.userId, input.occurrenceId);
    const rule: ReminderRuleSpec = { triggerKind: "exact", exactAt: input.intendedFor, purpose: "follow_up", quietPolicy: "respect", origin: "system" };
    const policy = applyNotificationPolicy({
      intendedFor: input.intendedFor,
      now: input.now,
      task: taskDefinitionFromRow(row.task),
      occurrence: occurrenceProjectionFromRow(row.occurrence),
      rule,
      settings: reminderSettingsFromRow(row.settings),
    });
    const ruleId = randomUUID();
    const deliveryId = randomUUID();
    await this.database.db.transaction(async (tx) => {
      const previous = await tx.select({ id: reminderRules.id }).from(reminderRules).where(and(
        eq(reminderRules.workspaceId, input.workspaceId),
        eq(reminderRules.occurrenceId, row.occurrence.id),
        eq(reminderRules.purpose, "follow_up"),
        eq(reminderRules.origin, "system"),
        eq(reminderRules.active, true),
      ));
      const ids = previous.map((item) => item.id);
      if (ids.length) {
        await tx.update(reminderDeliveries).set({ status: "cancelled", suppressedReason: "superseded" }).where(and(
          eq(reminderDeliveries.workspaceId, input.workspaceId),
          eq(reminderDeliveries.occurrenceId, row.occurrence.id),
          inArray(reminderDeliveries.status, ["pending", "processing"]),
          inArray(reminderDeliveries.reminderRuleId, ids),
        ));
        await tx.update(reminderRules).set({ active: false }).where(and(eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, ids)));
      }
      await tx.insert(reminderRules).values({
        id: ruleId,
        workspaceId: input.workspaceId,
        taskId: row.task.id,
        occurrenceId: row.occurrence.id,
        triggerKind: "exact",
        exactAt: input.intendedFor,
        purpose: "follow_up",
        quietPolicy: "respect",
        origin: "system",
      });
      await tx.insert(reminderDeliveries).values({
        id: deliveryId,
        workspaceId: input.workspaceId,
        recipientUserId: input.userId,
        reminderRuleId: ruleId,
        taskId: row.task.id,
        occurrenceId: row.occurrence.id,
        intendedFor: input.intendedFor,
        scheduledFor: policy.scheduledFor,
        status: policy.suppressedReason ? "suppressed" : "pending",
        ...(policy.suppressedReason ? { suppressedReason: policy.suppressedReason } : {}),
        deduplicationKey: `${ruleId}:${row.occurrence.id}:${input.intendedFor.toISOString()}`,
      });
      if (input.mode === "result") {
        await tx.insert(taskEvents).values({
          workspaceId: input.workspaceId,
          taskId: row.task.id,
          occurrenceId: row.occurrence.id,
          actorUserId: input.userId,
          eventType: "occurrence:result_check_scheduled",
        });
      }
    });
    if (!policy.suppressedReason) await this.queue.enqueue(deliveryId, policy.scheduledFor).catch((error) => {
      console.error("failed to enqueue follow-up; reconciliation will retry", { deliveryId, error: safeError(error) });
    });
    return deliveryId;
  }

  private async getOccurrenceSettings(workspaceId: string, userId: string, occurrenceId: string) {
    const [row] = await this.database.db
      .select({ task: tasks, occurrence: taskOccurrences, settings: userSettings })
      .from(taskOccurrences)
      .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, taskOccurrences.workspaceId), eq(workspaceMembers.userId, userId)))
      .innerJoin(userSettings, eq(userSettings.userId, workspaceMembers.userId))
      .where(and(eq(taskOccurrences.workspaceId, workspaceId), eq(taskOccurrences.id, occurrenceId)))
      .limit(1);
    if (!row) throw new Error("occurrence not found");
    return row;
  }

  private async enqueueCreated(rows: Array<typeof reminderDeliveries.$inferInsert>, label: string): Promise<void> {
    for (const delivery of rows) {
      if (delivery.status !== "pending" || !delivery.id) continue;
      await this.queue.enqueue(delivery.id, delivery.scheduledFor).catch((error) => {
        console.error(`failed to enqueue ${label}; reconciliation will retry`, { deliveryId: delivery.id, error: safeError(error) });
      });
    }
  }
}

function isTerminal(status: string): boolean {
  return ["done", "skipped", "cancelled", "elapsed"].includes(status);
}

function nextReferenceTime(now: Date, timezone: string, localTime: string): Date {
  const today = localDateAt(now, timezone);
  let value = localDateAndTimeToUtc(today, localTime, timezone).date;
  if (value <= now) value = localDateAndTimeToUtc(shiftLocalDate(today, 1), localTime, timezone).date;
  return value;
}
