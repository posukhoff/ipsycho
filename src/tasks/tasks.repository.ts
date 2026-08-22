import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import {
  reminderDeliveries,
  reminderRules,
  taskChecklistItems,
  taskEvents,
  taskOccurrences,
  taskRecurrenceExclusions,
  tasks,
  userSettings,
  workspaceMembers,
} from "../database/schema.js";

export interface PersistedTaskPlan {
  task: typeof tasks.$inferInsert & { id: string; workspaceId: string; createdByUserId: string };
  occurrences: Array<typeof taskOccurrences.$inferInsert>;
  reminderRules: Array<typeof reminderRules.$inferInsert>;
  reminderDeliveries: Array<typeof reminderDeliveries.$inferInsert>;
  checklist: Array<typeof taskChecklistItems.$inferInsert>;
  recurrenceExclusions: Array<typeof taskRecurrenceExclusions.$inferInsert>;
}

@Injectable()
export class TasksRepository {
  constructor(private readonly database: DatabaseService) {}

  async listActiveTasksForAi(workspaceId: string, limit = 12) {
    return this.database.db.select().from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "active")))
      .orderBy(desc(tasks.updatedAt))
      .limit(limit);
  }


  async listActionableForTelegram(workspaceId: string, limit?: number) {
    const query = this.database.db.select({ task: tasks, occurrence: taskOccurrences })
      .from(taskOccurrences)
      .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
      .where(and(
        eq(taskOccurrences.workspaceId, workspaceId),
        eq(tasks.status, "active"),
        inArray(taskOccurrences.status, ["scheduled", "open", "in_progress"]),
      ))
      .orderBy(
        sql`case ${tasks.importance} when 'critical' then 0 when 'required' then 1 else 2 end`,
        desc(taskOccurrences.overdue),
        asc(taskOccurrences.plannedStartAt),
        asc(taskOccurrences.dueAt),
        desc(tasks.updatedAt),
      );
    return limit === undefined ? query : query.limit(limit);
  }

  async listFuzzyForTelegram(workspaceId: string, limit = 12) {
    return this.database.db.select().from(tasks)
      .where(and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.status, "active"),
        eq(tasks.timeMode, "fuzzy"),
      ))
      .orderBy(
        sql`case ${tasks.importance} when 'critical' then 0 when 'required' then 1 else 2 end`,
        asc(tasks.reviewAt),
        desc(tasks.updatedAt),
      )
      .limit(limit);
  }

  async listRecentlyCompletedForTelegram(workspaceId: string, limit = 100) {
    return this.database.db.select({ task: tasks, occurrence: taskOccurrences })
      .from(taskOccurrences)
      .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
      .where(and(
        eq(taskOccurrences.workspaceId, workspaceId),
        inArray(tasks.status, ["active", "closed"]),
        eq(taskOccurrences.status, "done"),
      ))
      .orderBy(desc(taskOccurrences.completedAt))
      .limit(limit);
  }

  async listChecklistForTasks(workspaceId: string, taskIds: readonly string[]) {
    if (!taskIds.length) return [];
    return this.database.db.select().from(taskChecklistItems).where(and(
      eq(taskChecklistItems.workspaceId, workspaceId),
      inArray(taskChecklistItems.taskId, [...taskIds]),
    )).orderBy(asc(taskChecklistItems.sortOrder));
  }

  async listRecurrenceExclusions(workspaceId: string, taskIds: readonly string[]) {
    if (!taskIds.length) return [];
    return this.database.db.select().from(taskRecurrenceExclusions).where(and(
      eq(taskRecurrenceExclusions.workspaceId, workspaceId),
      inArray(taskRecurrenceExclusions.taskId, [...taskIds]),
    )).orderBy(asc(taskRecurrenceExclusions.taskId), asc(taskRecurrenceExclusions.localDate));
  }

  async listActiveOccurrencesForTasks(workspaceId: string, taskIds: readonly string[], limit = 40) {
    if (!taskIds.length) return [];
    return this.database.db.select().from(taskOccurrences).where(and(
      eq(taskOccurrences.workspaceId, workspaceId),
      inArray(taskOccurrences.taskId, [...taskIds]),
      inArray(taskOccurrences.status, ["scheduled", "open", "in_progress"]),
    )).orderBy(asc(taskOccurrences.plannedStartAt), asc(taskOccurrences.dueAt)).limit(limit);
  }

  async findTask(workspaceId: string, taskId: string) {
    const [row] = await this.database.db.select().from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId))).limit(1);
    return row ?? null;
  }

  async countActiveCritical(workspaceId: string): Promise<number> {
    const [row] = await this.database.db.select({ count: sql<number>`count(*)::int` }).from(tasks).where(and(
      eq(tasks.workspaceId, workspaceId), eq(tasks.status, "active"), eq(tasks.importance, "critical"),
    ));
    return row?.count ?? 0;
  }

  async markHabitOfferSent(workspaceId: string, taskId: string, now = new Date()): Promise<boolean> {
    const [row] = await this.database.db.update(tasks).set({ habitOfferSentAt: now }).where(and(
      eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId), sql`${tasks.habitOfferSentAt} IS NULL`,
    )).returning({ id: tasks.id });
    return Boolean(row);
  }

  async countOccurrenceEvents(workspaceId: string, occurrenceId: string, eventType: string): Promise<number> {
    const [row] = await this.database.db.select({ count: sql<number>`count(*)::int` }).from(taskEvents).where(and(
      eq(taskEvents.workspaceId, workspaceId), eq(taskEvents.occurrenceId, occurrenceId), eq(taskEvents.eventType, eventType),
    ));
    return row?.count ?? 0;
  }

  async countReschedules(workspaceId: string, occurrenceId: string): Promise<number> {
    const rows = await this.database.db.select({ id: taskEvents.id }).from(taskEvents).where(and(
      eq(taskEvents.workspaceId, workspaceId),
      eq(taskEvents.occurrenceId, occurrenceId),
      eq(taskEvents.eventType, "occurrence:rescheduled"),
    ));
    return rows.length;
  }

  async findOccurrence(workspaceId: string, occurrenceId: string) {
    const [row] = await this.database.db.select().from(taskOccurrences)
      .where(and(eq(taskOccurrences.workspaceId, workspaceId), eq(taskOccurrences.id, occurrenceId))).limit(1);
    return row ?? null;
  }

  async findMemberSettings(workspaceId: string, userId: string) {
    const [row] = await this.database.db
      .select({ settings: userSettings })
      .from(workspaceMembers)
      .innerJoin(userSettings, eq(userSettings.userId, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1);
    return row?.settings ?? null;
  }

  async createPlan(plan: PersistedTaskPlan): Promise<void> {
    await this.createPlans([plan]);
  }

  async createPlans(plans: readonly PersistedTaskPlan[]): Promise<void> {
    if (!plans.length) return;
    await this.database.db.transaction(async (tx) => {
      for (const plan of plans) {
        await tx.insert(tasks).values(plan.task);
        if (plan.recurrenceExclusions.length) await tx.insert(taskRecurrenceExclusions).values(plan.recurrenceExclusions);
        if (plan.occurrences.length) await tx.insert(taskOccurrences).values(plan.occurrences);
        if (plan.reminderRules.length) await tx.insert(reminderRules).values(plan.reminderRules);
        if (plan.reminderDeliveries.length) await tx.insert(reminderDeliveries).values(plan.reminderDeliveries);
        if (plan.checklist.length) await tx.insert(taskChecklistItems).values(plan.checklist);
        await tx.insert(taskEvents).values({
          workspaceId: plan.task.workspaceId,
          taskId: plan.task.id,
          ...(plan.task.createdByUserId ? { actorUserId: plan.task.createdByUserId } : {}),
          eventType: "task:created",
        });
      }
    });
  }

  async deleteTasksIfVersions(workspaceId: string, expected: readonly { id: string; version: number }[]): Promise<void> {
    if (!expected.length) return;
    await this.database.db.transaction(async (tx) => {
      const ids = expected.map((item) => item.id);
      const rows = await tx.select({ id: tasks.id, version: tasks.version }).from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, ids)));
      if (rows.length !== expected.length) throw new Error("undo target missing");
      const versions = new Map(rows.map((row) => [row.id, row.version]));
      for (const item of expected) {
        if (versions.get(item.id) !== item.version) throw new Error("undo target changed after action");
      }
      await tx.delete(tasks).where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.id, ids)));
    });
  }

  async findTasksBySourceActionGroup(workspaceId: string, groupId: string) {
    return this.database.db.select({ id: tasks.id, version: tasks.version, title: tasks.title }).from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.sourceActionGroupId, groupId)));
  }

  async recordEvent(input: {
    workspaceId: string;
    taskId: string;
    occurrenceId?: string;
    actorUserId?: string;
    eventType: string;
    details?: string;
  }): Promise<void> {
    await this.database.db.insert(taskEvents).values({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      ...(input.occurrenceId ? { occurrenceId: input.occurrenceId } : {}),
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
      eventType: input.eventType,
      ...(input.details ? { details: input.details } : {}),
    });
  }

  async markIgnoredResultChecks(cutoff: Date, now = new Date(), limit = 200): Promise<number> {
    const sentChecks = await this.database.db.select({
      id: taskEvents.id, workspaceId: taskEvents.workspaceId, taskId: taskEvents.taskId,
      occurrenceId: taskEvents.occurrenceId, createdAt: taskEvents.createdAt,
    }).from(taskEvents).where(and(
      eq(taskEvents.eventType, "occurrence:result_check_sent"),
      lte(taskEvents.createdAt, cutoff),
      isNotNull(taskEvents.occurrenceId),
    )).orderBy(asc(taskEvents.createdAt)).limit(limit);

    let marked = 0;
    for (const sent of sentChecks) {
      if (!sent.occurrenceId) continue;
      const [occurrence] = await this.database.db.select({ status: taskOccurrences.status }).from(taskOccurrences).where(and(
        eq(taskOccurrences.workspaceId, sent.workspaceId), eq(taskOccurrences.id, sent.occurrenceId),
      )).limit(1);
      if (occurrence?.status !== "in_progress") continue;

      const later = await this.database.db.select({ eventType: taskEvents.eventType, actorUserId: taskEvents.actorUserId }).from(taskEvents).where(and(
        eq(taskEvents.workspaceId, sent.workspaceId),
        eq(taskEvents.occurrenceId, sent.occurrenceId),
        gt(taskEvents.createdAt, sent.createdAt),
      )).orderBy(asc(taskEvents.createdAt)).limit(50);
      if (later.some((event) => event.eventType === "occurrence:result_check_ignored")) continue;
      if (later.some((event) => event.actorUserId !== null)) continue;

      await this.database.db.insert(taskEvents).values({
        workspaceId: sent.workspaceId, taskId: sent.taskId, occurrenceId: sent.occurrenceId,
        eventType: "occurrence:result_check_ignored", createdAt: now,
      });
      marked += 1;
    }
    return marked;
  }

  async clearEventDetailsOlderThan(cutoff: Date): Promise<number> {
    const rows = await this.database.db.update(taskEvents).set({ details: null }).where(and(
      lt(taskEvents.createdAt, cutoff),
      isNotNull(taskEvents.details),
    )).returning({ id: taskEvents.id });
    return rows.length;
  }


  async listLifecycleCandidates(limit = 1000) {
    return this.database.db
      .select({ task: tasks, occurrence: taskOccurrences })
      .from(taskOccurrences)
      .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
      .where(and(
        eq(tasks.status, "active"),
        inArray(taskOccurrences.status, ["scheduled", "open", "in_progress"]),
      ))
      .limit(limit);
  }

  async markOccurrenceOverdue(input: { workspaceId: string; occurrenceId: string; expectedVersion: number }): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const [updated] = await tx.update(taskOccurrences)
        .set({ overdue: true, version: sql`${taskOccurrences.version} + 1`, updatedAt: new Date() })
        .where(and(
          eq(taskOccurrences.workspaceId, input.workspaceId),
          eq(taskOccurrences.id, input.occurrenceId),
          eq(taskOccurrences.version, input.expectedVersion),
          eq(taskOccurrences.overdue, false),
        ))
        .returning({ taskId: taskOccurrences.taskId, id: taskOccurrences.id });
      if (!updated) return false;
      await tx.insert(taskEvents).values({
        workspaceId: input.workspaceId,
        taskId: updated.taskId,
        occurrenceId: updated.id,
        eventType: "occurrence:overdue",
      });
      return true;
    });
  }

  async transitionOccurrence(input: {
    workspaceId: string;
    occurrenceId: string;
    expectedVersion: number;
    expectedTaskVersion: number;
    nextStatus: "scheduled" | "open" | "in_progress" | "done" | "skipped" | "cancelled" | "elapsed";
    nextTaskStatus?: "active" | "paused" | "closed" | "cancelled";
    actorUserId?: string;
    eventType: string;
    patch?: Partial<typeof taskOccurrences.$inferInsert>;
  }) {
    return this.database.db.transaction(async (tx) => {
      const [updated] = await tx.update(taskOccurrences)
        .set({
          ...input.patch,
          status: input.nextStatus,
          version: sql`${taskOccurrences.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(taskOccurrences.workspaceId, input.workspaceId),
          eq(taskOccurrences.id, input.occurrenceId),
          eq(taskOccurrences.version, input.expectedVersion),
        ))
        .returning();
      if (!updated) throw new Error("stale or missing occurrence");

      if (input.nextTaskStatus) {
        const [updatedTask] = await tx.update(tasks)
          .set({
            status: input.nextTaskStatus,
            version: sql`${tasks.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(
            eq(tasks.workspaceId, input.workspaceId),
            eq(tasks.id, updated.taskId),
            eq(tasks.version, input.expectedTaskVersion),
          ))
          .returning({ id: tasks.id });
        if (!updatedTask) throw new Error("stale or missing task");
      }

      if (input.nextStatus === "in_progress") {
        const followUpRules = await tx.select({ id: reminderRules.id }).from(reminderRules).where(and(
          eq(reminderRules.workspaceId, input.workspaceId),
          eq(reminderRules.occurrenceId, updated.id),
          eq(reminderRules.purpose, "follow_up"),
          eq(reminderRules.active, true),
        ));
        const followUpRuleIds = followUpRules.map((item) => item.id);
        if (followUpRuleIds.length) {
          await tx.update(reminderDeliveries)
            .set({ status: "cancelled", suppressedReason: "superseded" })
            .where(and(
              eq(reminderDeliveries.workspaceId, input.workspaceId),
              eq(reminderDeliveries.occurrenceId, updated.id),
              inArray(reminderDeliveries.status, ["pending", "processing"]),
              inArray(reminderDeliveries.reminderRuleId, followUpRuleIds),
            ));
          await tx.update(reminderRules).set({ active: false }).where(and(eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, followUpRuleIds)));
        }
      }

      if (["done", "skipped", "cancelled", "elapsed"].includes(input.nextStatus)) {
        await tx.update(reminderDeliveries)
          .set({ status: "suppressed", suppressedReason: "no_longer_applicable" })
          .where(and(
            eq(reminderDeliveries.workspaceId, input.workspaceId),
            eq(reminderDeliveries.occurrenceId, updated.id),
            inArray(reminderDeliveries.status, ["pending", "processing"]),
          ));
      }

      await tx.insert(taskEvents).values({
        workspaceId: input.workspaceId,
        taskId: updated.taskId,
        occurrenceId: updated.id,
        ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
        eventType: input.eventType,
      });
      return updated;
    });
  }
}
