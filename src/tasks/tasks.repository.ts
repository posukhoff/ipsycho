import { Injectable } from "@nestjs/common";
import { isTerminalOccurrenceStatus } from "../core/types.js";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { tsQueryFor } from "../core/search-query.js";
import { CLEANUP_BATCH, drainInBatches } from "../database/batched.js";
import { DatabaseService } from "../database/database.service.js";
import {
  goals,
  reminderDeliveries,
  reminderRules,
  taskChecklistItems,
  taskEvents,
  taskGoals,
  taskOccurrences,
  taskRecurrenceExclusions,
  tasks,
  userSettings,
  workspaceMembers,
  workspaces,
} from "../database/schema.js";
import { DomainRuleError } from "../core/errors.js";

export interface PersistedTaskPlan {
  task: typeof tasks.$inferInsert & { id: string; workspaceId: string; createdByUserId: string };
  occurrences: Array<typeof taskOccurrences.$inferInsert>;
  reminderRules: Array<typeof reminderRules.$inferInsert>;
  reminderDeliveries: Array<typeof reminderDeliveries.$inferInsert>;
  checklist: Array<typeof taskChecklistItems.$inferInsert>;
  recurrenceExclusions: Array<typeof taskRecurrenceExclusions.$inferInsert>;
}

/** Upper bound on tasks loaded for one model turn; the context layer shows at most 60 of them. */
export const AI_TASK_RETRIEVAL_LIMIT = 300;

@Injectable()
export class TasksRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Every task the assistant may address: active and paused series, newest change first.
   * The cap keeps one turn's retrieval bounded; the context layer selects the nearest ones anyway.
   */
  async listActiveTasksForAi(workspaceId: string, limit = AI_TASK_RETRIEVAL_LIMIT) {
    return this.database.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, ["active", "paused"])))
      .orderBy(desc(tasks.updatedAt))
      .limit(limit);
  }

  /**
   * Full-text match over title and context. The expression must stay identical to the one in
   * `tasks_fts_idx` (migration 0025) or the planner will not use the index.
   */
  async searchActiveTasks(workspaceId: string, query: string, limit = 20) {
    const tsQuery = tsQueryFor(query);
    if (!tsQuery) return [];
    const vector = sql`to_tsvector('simple', ${tasks.title} || ' ' || coalesce(${tasks.context}, ''))`;
    const searchQuery = sql`to_tsquery('simple', ${tsQuery})`;
    return this.database.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), inArray(tasks.status, ["active", "paused"]), sql`${vector} @@ ${searchQuery}`))
      .orderBy(desc(sql`ts_rank_cd(${vector}, ${searchQuery})`), desc(tasks.updatedAt))
      .limit(limit);
  }

  /**
   * The occurrence a task-addressed action lands on: something in progress first, then the open
   * one, then the nearest scheduled; elapsed only when the caller can still act on it (completion).
   */
  async findCurrentOccurrence(workspaceId: string, taskId: string, opts: { includeElapsed?: boolean } = {}) {
    const statuses: Array<(typeof taskOccurrences.$inferSelect)["status"]> = opts.includeElapsed
      ? ["in_progress", "open", "scheduled", "elapsed"]
      : ["in_progress", "open", "scheduled"];
    const [row] = await this.database.db
      .select()
      .from(taskOccurrences)
      .where(and(eq(taskOccurrences.workspaceId, workspaceId), eq(taskOccurrences.taskId, taskId), inArray(taskOccurrences.status, statuses)))
      .orderBy(
        sql`case ${taskOccurrences.status} when 'in_progress' then 0 when 'open' then 1 when 'scheduled' then 2 else 3 end`,
        sql`coalesce(${taskOccurrences.plannedStartAt}, ${taskOccurrences.dueAt}) asc nulls last`,
        asc(taskOccurrences.plannedLocalDate),
        asc(taskOccurrences.dueLocalDate),
        asc(taskOccurrences.id),
      )
      .limit(1);
    return row ?? null;
  }

  /** `findCurrentOccurrence` for many tasks in one query, keyed by task id. */
  async findCurrentOccurrences(workspaceId: string, taskIds: readonly string[]) {
    const result = new Map<string, typeof taskOccurrences.$inferSelect>();
    if (!taskIds.length) return result;
    const rows = await this.database.db
      .selectDistinctOn([taskOccurrences.taskId])
      .from(taskOccurrences)
      .where(
        and(eq(taskOccurrences.workspaceId, workspaceId), inArray(taskOccurrences.taskId, [...taskIds]), inArray(taskOccurrences.status, ["in_progress", "open", "scheduled"])),
      )
      .orderBy(
        asc(taskOccurrences.taskId),
        sql`case ${taskOccurrences.status} when 'in_progress' then 0 when 'open' then 1 when 'scheduled' then 2 else 3 end`,
        sql`coalesce(${taskOccurrences.plannedStartAt}, ${taskOccurrences.dueAt}) asc nulls last`,
        asc(taskOccurrences.plannedLocalDate),
        asc(taskOccurrences.dueLocalDate),
        asc(taskOccurrences.id),
      );
    for (const row of rows) result.set(row.taskId, row);
    return result;
  }

  async listActionableForTelegram(workspaceId: string, limit?: number) {
    const query = this.database.db
      .select({ task: tasks, occurrence: taskOccurrences })
      .from(taskOccurrences)
      .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
      .where(and(eq(taskOccurrences.workspaceId, workspaceId), eq(tasks.status, "active"), inArray(taskOccurrences.status, ["scheduled", "open", "in_progress"])))
      .orderBy(
        sql`case ${tasks.importance} when 'critical' then 0 when 'required' then 1 else 2 end`,
        desc(taskOccurrences.overdue),
        asc(taskOccurrences.plannedStartAt),
        asc(taskOccurrences.dueAt),
        desc(tasks.updatedAt),
      );
    return limit === undefined ? query : query.limit(limit);
  }

  /**
   * Series the user paused. Their parent row is not `active` and every future occurrence is
   * cancelled, so they appear in no other list: without this query a paused series is invisible
   * and cannot be resumed.
   */
  async listPausedSeriesForTelegram(workspaceId: string, options: { limit: number; offset?: number }) {
    return this.database.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "paused"), isNotNull(tasks.recurrenceRule)))
      .orderBy(sql`case ${tasks.importance} when 'critical' then 0 when 'required' then 1 else 2 end`, desc(tasks.updatedAt))
      .limit(options.limit)
      .offset(options.offset ?? 0);
  }

  /** The chip on the task screen counts them all: a capped list would understate what is hidden. */
  async countPausedSeries(workspaceId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "paused"), isNotNull(tasks.recurrenceRule)));
    return row?.count ?? 0;
  }

  /**
   * The pool: active tasks with no date. The week screen orders them in the domain (a pick left over
   * from last week goes first), so the query only bounds the read.
   */
  async listPoolForTelegram(workspaceId: string, limit = 200) {
    return this.database.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "active"), eq(tasks.timeMode, "fuzzy")))
      .orderBy(desc(tasks.updatedAt))
      .limit(limit);
  }

  async countPool(workspaceId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "active"), eq(tasks.timeMode, "fuzzy")));
    return row?.count ?? 0;
  }

  /** Tasks taken for the given week and still waiting for a day. */
  async listPickedForWeek(workspaceId: string, weekStart: string, limit = 20) {
    return this.database.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "active"), eq(tasks.timeMode, "fuzzy"), eq(tasks.pickedWeekStart, weekStart)))
      .orderBy(sql`case ${tasks.importance} when 'critical' then 0 when 'required' then 1 else 2 end`, desc(tasks.updatedAt))
      .limit(limit);
  }

  /**
   * Takes a pool task for the given week or puts it back; the same tap is the reversal, so this is
   * not an action group. The count and the write are one transaction: the cap has to hold when two
   * taps arrive together.
   */
  async togglePickedForWeek(workspaceId: string, taskId: string, weekStart: string, limit: number, now = new Date()): Promise<"picked" | "released" | "full" | null> {
    return this.database.db.transaction(async (tx) => {
      // The cap is a property of the whole week, not of one row, so the workspace is what has to be
      // held: locking only the tapped task lets two taps each count six and both write the seventh.
      await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
      const [task] = await tx
        .select({ pickedWeekStart: tasks.pickedWeekStart })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId), eq(tasks.status, "active"), eq(tasks.timeMode, "fuzzy")))
        .for("update");
      if (!task) return null;
      if (task.pickedWeekStart === weekStart) {
        await tx
          .update(tasks)
          .set({ pickedWeekStart: null, updatedAt: now })
          .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)));
        return "released";
      }
      const [picked] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "active"), eq(tasks.timeMode, "fuzzy"), eq(tasks.pickedWeekStart, weekStart)));
      if ((picked?.count ?? 0) >= limit) return "full";
      await tx
        .update(tasks)
        .set({ pickedWeekStart: weekStart, updatedAt: now })
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)));
      return "picked";
    });
  }

  /**
   * What the past week did: occurrences closed inside it, and tasks taken for it that never got a
   * day. Both are read from the state itself, so no counter has to be kept up to date.
   */
  async summariseWeek(workspaceId: string, range: { start: string; end: string }): Promise<{ done: number; takenNotStarted: number }> {
    const [done] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(taskOccurrences)
      .where(
        and(
          eq(taskOccurrences.workspaceId, workspaceId),
          eq(taskOccurrences.status, "done"),
          sql`(${taskOccurrences.completedAt} AT TIME ZONE ${taskOccurrences.timezone})::date between ${range.start}::date and ${range.end}::date`,
        ),
      );
    const [taken] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "active"), eq(tasks.timeMode, "fuzzy"), eq(tasks.pickedWeekStart, range.start)))
      .limit(1);
    return { done: done?.count ?? 0, takenNotStarted: taken?.count ?? 0 };
  }

  async listFuzzyForTelegram(workspaceId: string, limit = 12) {
    return this.database.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "active"), eq(tasks.timeMode, "fuzzy")))
      .orderBy(sql`case ${tasks.importance} when 'critical' then 0 when 'required' then 1 else 2 end`, asc(tasks.reviewAt), desc(tasks.updatedAt))
      .limit(limit);
  }

  async listFuzzyReviewsForLocalDate(workspaceId: string, localDate: string, limit = 20) {
    return this.database.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.status, "active"),
          eq(tasks.timeMode, "fuzzy"),
          sql`(${tasks.reviewAt} AT TIME ZONE ${tasks.timezone})::date = ${localDate}::date`,
        ),
      )
      .orderBy(sql`case ${tasks.importance} when 'critical' then 0 when 'required' then 1 else 2 end`, asc(tasks.reviewAt), desc(tasks.updatedAt))
      .limit(limit);
  }

  async listRecentlyCompletedForTelegram(workspaceId: string, limit = 100) {
    return this.database.db
      .select({ task: tasks, occurrence: taskOccurrences })
      .from(taskOccurrences)
      .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
      .where(and(eq(taskOccurrences.workspaceId, workspaceId), inArray(tasks.status, ["active", "closed"]), eq(taskOccurrences.status, "done")))
      .orderBy(desc(taskOccurrences.completedAt))
      .limit(limit);
  }

  async findGoalTitleForTask(workspaceId: string, taskId: string): Promise<string | null> {
    const [row] = await this.database.db
      .select({ title: goals.title })
      .from(taskGoals)
      .innerJoin(goals, and(eq(goals.workspaceId, taskGoals.workspaceId), eq(goals.id, taskGoals.goalId)))
      .where(and(eq(taskGoals.workspaceId, workspaceId), eq(taskGoals.taskId, taskId)))
      .limit(1);
    return row?.title ?? null;
  }

  async listChecklistForTasks(workspaceId: string, taskIds: readonly string[]) {
    if (!taskIds.length) return [];
    return this.database.db
      .select()
      .from(taskChecklistItems)
      .where(and(eq(taskChecklistItems.workspaceId, workspaceId), inArray(taskChecklistItems.taskId, [...taskIds])))
      .orderBy(asc(taskChecklistItems.sortOrder));
  }

  async listActiveOccurrencesForTasks(workspaceId: string, taskIds: readonly string[]) {
    if (!taskIds.length) return [];
    return this.database.db
      .select()
      .from(taskOccurrences)
      .where(
        and(eq(taskOccurrences.workspaceId, workspaceId), inArray(taskOccurrences.taskId, [...taskIds]), inArray(taskOccurrences.status, ["scheduled", "open", "in_progress"])),
      )
      .orderBy(asc(taskOccurrences.plannedStartAt), asc(taskOccurrences.dueAt));
  }

  async findTask(workspaceId: string, taskId: string) {
    const [row] = await this.database.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.id, taskId)))
      .limit(1);
    return row ?? null;
  }

  async countActiveCritical(workspaceId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "active"), eq(tasks.importance, "critical")));
    return row?.count ?? 0;
  }

  async countOccurrenceEvents(workspaceId: string, occurrenceId: string, eventType: string): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(taskEvents)
      .where(and(eq(taskEvents.workspaceId, workspaceId), eq(taskEvents.occurrenceId, occurrenceId), eq(taskEvents.eventType, eventType)));
    return row?.count ?? 0;
  }

  async countReschedules(workspaceId: string, occurrenceId: string): Promise<number> {
    const rows = await this.database.db
      .select({ id: taskEvents.id })
      .from(taskEvents)
      .where(and(eq(taskEvents.workspaceId, workspaceId), eq(taskEvents.occurrenceId, occurrenceId), eq(taskEvents.eventType, "occurrence:rescheduled")));
    return rows.length;
  }

  async findOccurrence(workspaceId: string, occurrenceId: string) {
    const [row] = await this.database.db
      .select()
      .from(taskOccurrences)
      .where(and(eq(taskOccurrences.workspaceId, workspaceId), eq(taskOccurrences.id, occurrenceId)))
      .limit(1);
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

  async createPlans(plans: readonly PersistedTaskPlan[]): Promise<void> {
    if (!plans.length) return;
    await this.database.db.transaction(async (tx) => {
      for (const plan of plans) await insertTaskPlan(tx, plan);
    });
  }

  async clearEventDetailsOlderThan(cutoff: Date, batchSize = CLEANUP_BATCH): Promise<number> {
    return drainInBatches(batchSize, async () => {
      const batch = this.database.db
        .select({ id: taskEvents.id })
        .from(taskEvents)
        .where(and(lt(taskEvents.createdAt, cutoff), isNotNull(taskEvents.details)))
        .limit(batchSize);
      const result = await this.database.db.update(taskEvents).set({ details: null }).where(inArray(taskEvents.id, batch));
      return result.rowCount ?? 0;
    });
  }

  /** The task journal is not kept forever: counters and history readers only look at recent rows. */
  async deleteEventsOlderThan(cutoff: Date, batchSize = CLEANUP_BATCH): Promise<number> {
    return drainInBatches(batchSize, async () => {
      const batch = this.database.db.select({ id: taskEvents.id }).from(taskEvents).where(lt(taskEvents.createdAt, cutoff)).limit(batchSize);
      const result = await this.database.db.delete(taskEvents).where(inArray(taskEvents.id, batch));
      return result.rowCount ?? 0;
    });
  }

  /** One page of live occurrences in id order; the caller walks pages so no row is starved by a LIMIT. */
  async listLifecycleCandidates(afterId: string | null, limit = 500) {
    return this.database.db
      .select({ task: tasks, occurrence: taskOccurrences })
      .from(taskOccurrences)
      .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
      .where(and(eq(tasks.status, "active"), inArray(taskOccurrences.status, ["scheduled", "open", "in_progress"]), afterId ? gt(taskOccurrences.id, afterId) : undefined))
      .orderBy(asc(taskOccurrences.id))
      .limit(limit);
  }

  async markOccurrenceOverdue(input: { workspaceId: string; occurrenceId: string; expectedVersion: number }): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(taskOccurrences)
        .set({ overdue: true, version: sql`${taskOccurrences.version} + 1`, updatedAt: new Date() })
        .where(
          and(
            eq(taskOccurrences.workspaceId, input.workspaceId),
            eq(taskOccurrences.id, input.occurrenceId),
            eq(taskOccurrences.version, input.expectedVersion),
            eq(taskOccurrences.overdue, false),
          ),
        )
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
      const [updated] = await tx
        .update(taskOccurrences)
        .set({
          ...input.patch,
          status: input.nextStatus,
          version: sql`${taskOccurrences.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, input.occurrenceId), eq(taskOccurrences.version, input.expectedVersion)))
        .returning();
      if (!updated) throw new DomainRuleError("stale or missing occurrence");

      if (input.nextTaskStatus) {
        const [updatedTask] = await tx
          .update(tasks)
          .set({
            status: input.nextTaskStatus,
            version: sql`${tasks.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, updated.taskId), eq(tasks.version, input.expectedTaskVersion)))
          .returning({ id: tasks.id });
        if (!updatedTask) throw new DomainRuleError("stale or missing task");
      }

      if (isTerminalOccurrenceStatus(input.nextStatus)) {
        await tx
          .update(reminderDeliveries)
          .set({ status: "suppressed", suppressedReason: "no_longer_applicable" })
          .where(
            and(
              eq(reminderDeliveries.workspaceId, input.workspaceId),
              eq(reminderDeliveries.occurrenceId, updated.id),
              inArray(reminderDeliveries.status, ["pending", "processing"]),
            ),
          );
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

export type TasksTransaction = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];

/** Persists one prepared task with its occurrences, rules, deliveries, checklist and creation event. */
export async function insertTaskPlan(tx: TasksTransaction, plan: PersistedTaskPlan): Promise<void> {
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
