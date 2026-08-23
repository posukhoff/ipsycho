import crypto from "node:crypto";
import { Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { validateOccurrenceTransition } from "../core/occurrence.js";
import { rescheduledDefinition, rescheduledOccurrenceStatus, type RescheduleFields } from "../core/reschedule.js";
import { isRescheduleReasonRequired } from "../core/task-policy.js";
import { localDateAt } from "../core/timezone.js";
import type { OccurrenceScheduleView } from "../core/time-presentation.js";
import { taskFieldChanges, type TaskFieldChange } from "../core/applied-report.js";
import type { ReminderRuleSpec } from "../core/reminder-planning.js";
import type { TaskDefinition } from "../core/types.js";
import { DatabaseService } from "../database/database.service.js";
import {
  actionEvents,
  actionGroups,
  pendingActions,
  reminderDeliveries,
  reminderRules,
  taskChecklistItems,
  taskEvents,
  taskOccurrences,
  taskRecurrenceExclusions,
  tasks,
  userSettings,
} from "../database/schema.js";
import { taskDefinitionFromRow } from "../tasks/task-record-mappers.js";
import { seriesOperationState } from "../core/series-policy.js";

type DbTransaction = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];

export interface MutationAppliedResult {
  groupId: string;
  undoable?: boolean;
  count: 1;
  titles: string[];
  reminderRebuildOccurrenceId?: string;
  reminderRebuildTaskId?: string;
  recurrenceReconcileTaskId?: string;
  occurrenceSchedule?: OccurrenceScheduleView;
  /** Previous title when an update_task changed it, so the reply can show old → new. */
  renamedFrom?: string;
  /** Field-level diff of an update_task, rendered verbatim in the applied report. */
  changes?: TaskFieldChange[];
  /** Schedule before a reschedule, so the report can show old → new. */
  previousSchedule?: OccurrenceScheduleView;
  scheduledReminderAt?: Date;
}

@Injectable()
export class ActionMutationsRepository {
  constructor(private readonly database: DatabaseService) {}

  async applyUpdateSettings(input: {
    workspaceId: string; groupId: string; actorUserId: string; expectedVersion: number;
    patch: Partial<Pick<typeof userSettings.$inferInsert,
      "timezone" | "digestTimezone" | "quietHoursTimezone" | "pinnedLanguage" |
      "quietHoursEnabled" | "weekdayQuietStart" | "weekdayQuietEnd" | "weekendQuietStart" | "weekendQuietEnd" |
      "notificationsSnoozedUntil" | "morningReferenceTime" | "eveningReferenceTime" |
      "morningDigestEnabled" | "eveningDigestEnabled" | "weeklyReviewEnabled" | "weeklyReviewWeekday" | "weeklyReviewTime" |
      "eventReminderOffsetsMinutes" | "plannedTaskReminderOffsetMinutes" | "criticalPostDueMinutes" |
      "seenNormalMinutes" | "seenRequiredMinutes" | "seenCriticalMinutes">>;
    now: Date; undoExpiresAt: Date;
  }): Promise<MutationAppliedResult> {
    return this.database.db.transaction(async (tx) => {
      const [before] = await tx.select().from(userSettings).where(and(
        eq(userSettings.userId, input.actorUserId), eq(userSettings.version, input.expectedVersion),
      )).limit(1);
      if (!before) throw new Error("settings are stale or missing");
      const [after] = await tx.update(userSettings).set({
        ...input.patch, version: sql`${userSettings.version} + 1`, updatedAt: input.now,
      }).where(and(eq(userSettings.userId, input.actorUserId), eq(userSettings.version, input.expectedVersion))).returning();
      if (!after) throw new Error("settings are stale or missing");
      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId, groupId: input.groupId, actionType: "update_settings",
        entityType: "settings", entityId: input.actorUserId, postVersion: after.version,
        beforeState: settingsMutableState(before), afterState: settingsMutableState(after),
      });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: ["Настройки"] };
    });
  }

  async applyUpdateOccurrence(input: {
    workspaceId: string; groupId: string; actorUserId: string; occurrenceId: string; expectedVersion: number;
    operation: "start" | "skip" | "cancel"; now: Date; undoExpiresAt: Date;
  }): Promise<MutationAppliedResult> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx.select({ task: tasks, occurrence: taskOccurrences }).from(taskOccurrences)
        .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
        .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, input.occurrenceId), eq(taskOccurrences.version, input.expectedVersion))).limit(1);
      if (!row) throw new Error("occurrence is stale or missing");
      const nextStatus = input.operation === "start" ? "in_progress" : input.operation === "skip" ? "skipped" : "cancelled";
      const transition = validateOccurrenceTransition(row.occurrence.status, nextStatus, {
        kind: row.task.kind, recurring: Boolean(row.task.recurrenceRule), now: input.now,
        ...(row.occurrence.plannedStartAt ? { plannedStartAt: row.occurrence.plannedStartAt } : {}),
        ...(row.occurrence.plannedEndAt ? { plannedEndAt: row.occurrence.plannedEndAt } : {}),
        eventElapseGraceMinutes: 15, explicitUserAction: true, systemExpire: false,
      });
      if (!transition.ok) throw new Error(transition.reason);
      const [afterOccurrence] = await tx.update(taskOccurrences).set({
        status: nextStatus, version: sql`${taskOccurrences.version} + 1`, updatedAt: input.now,
      }).where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, input.occurrenceId), eq(taskOccurrences.version, input.expectedVersion))).returning();
      if (!afterOccurrence) throw new Error("occurrence is stale or missing");
      const activeSystemFollowUps = input.operation === "start" ? await tx.select({ id: reminderRules.id }).from(reminderRules).where(and(
        eq(reminderRules.workspaceId, input.workspaceId), eq(reminderRules.occurrenceId, input.occurrenceId),
        eq(reminderRules.purpose, "follow_up"), eq(reminderRules.origin, "system"), eq(reminderRules.active, true),
      )) : [];
      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId, groupId: input.groupId, actionType: "update_occurrence", entityType: "occurrence",
        entityId: input.occurrenceId, postVersion: afterOccurrence.version,
        beforeState: { ...occurrenceMutableState(row.occurrence), systemFollowUpRuleIds: activeSystemFollowUps.map((item) => item.id) }, afterState: occurrenceMutableState(afterOccurrence),
      });
      if (input.operation === "cancel" && !row.task.recurrenceRule) {
        const [afterTask] = await tx.update(tasks).set({ status: "cancelled", version: sql`${tasks.version} + 1`, updatedAt: input.now })
          .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, row.task.id), eq(tasks.version, row.task.version))).returning();
        if (!afterTask) throw new Error("task changed while cancelling occurrence");
        await tx.insert(actionEvents).values({
          workspaceId: input.workspaceId, groupId: input.groupId, actionType: "update_occurrence", entityType: "task",
          entityId: row.task.id, postVersion: afterTask.version, beforeState: taskMutableState(row.task), afterState: taskMutableState(afterTask),
        });
      }
      if (input.operation === "start") {
        const ids = activeSystemFollowUps.map((item) => item.id);
        if (ids.length) {
          await tx.update(reminderDeliveries).set({ status: "cancelled", suppressedReason: "superseded" }).where(and(
            eq(reminderDeliveries.workspaceId, input.workspaceId), eq(reminderDeliveries.occurrenceId, input.occurrenceId),
            inArray(reminderDeliveries.reminderRuleId, ids), inArray(reminderDeliveries.status, ["pending", "processing"]),
          ));
          await tx.update(reminderRules).set({ active: false }).where(and(eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, ids)));
        }
      } else {
        await tx.update(reminderDeliveries).set({ status: "suppressed", suppressedReason: "no_longer_applicable" }).where(and(
          eq(reminderDeliveries.workspaceId, input.workspaceId), eq(reminderDeliveries.occurrenceId, input.occurrenceId),
          inArray(reminderDeliveries.status, ["pending", "processing"]),
        ));
      }
      await tx.insert(taskEvents).values({
        workspaceId: input.workspaceId, taskId: row.task.id, occurrenceId: input.occurrenceId,
        actorUserId: input.actorUserId, eventType: `occurrence:${nextStatus}`,
      });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: [row.task.title] };
    });
  }

  async applyOccurrenceInteraction(input: {
    workspaceId: string; groupId: string; actorUserId: string; occurrenceId: string; expectedVersion: number;
    operation: "seen" | "record_blocker"; details?: string; now: Date;
  }): Promise<MutationAppliedResult> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx.select({ task: tasks, occurrence: taskOccurrences }).from(taskOccurrences)
        .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
        .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, input.occurrenceId), eq(taskOccurrences.version, input.expectedVersion))).limit(1);
      if (!row) throw new Error("occurrence is stale or missing");
      await tx.insert(taskEvents).values(input.operation === "seen" ? [{
        workspaceId: input.workspaceId, taskId: row.task.id, occurrenceId: input.occurrenceId,
        actorUserId: input.actorUserId, eventType: "occurrence:seen",
      }] : [{
        workspaceId: input.workspaceId, taskId: row.task.id, occurrenceId: input.occurrenceId,
        actorUserId: input.actorUserId, eventType: "occurrence:cant_start",
      }, {
        workspaceId: input.workspaceId, taskId: row.task.id, occurrenceId: input.occurrenceId,
        actorUserId: input.actorUserId, eventType: "occurrence:blocker", details: input.details,
      }]);
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.now);
      return { groupId: input.groupId, undoable: false, count: 1, titles: [row.task.title] };
    });
  }

  async applyUpdateTask(input: {
    workspaceId: string;
    groupId: string;
    actorUserId: string;
    taskId: string;
    expectedVersion: number;
    patch: {
      title?: string; why?: string; nextAction?: string; context?: string; importance?: "normal" | "required" | "critical";
      checklist?: Array<{ text: string; done: boolean }>;
      habitMode?: boolean; minimumAction?: string | null; desiredAction?: string | null; habitTrigger?: string | null;
    };
    undoExpiresAt: Date;
  }): Promise<MutationAppliedResult> {
    return this.database.db.transaction(async (tx) => {
      const [before] = await tx.select().from(tasks).where(and(
        eq(tasks.workspaceId, input.workspaceId),
        eq(tasks.id, input.taskId),
        eq(tasks.version, input.expectedVersion),
      )).limit(1);
      if (!before) throw new Error("task is stale or missing");

      const beforeChecklist = await tx.select({ text: taskChecklistItems.text, done: taskChecklistItems.done })
        .from(taskChecklistItems)
        .where(and(eq(taskChecklistItems.workspaceId, input.workspaceId), eq(taskChecklistItems.taskId, input.taskId)))
        .orderBy(taskChecklistItems.sortOrder);
      const { checklist, ...taskPatch } = input.patch;
      if (taskPatch.habitMode === false) {
        taskPatch.minimumAction = null; taskPatch.desiredAction = null; taskPatch.habitTrigger = null;
      }
      const [after] = await tx.update(tasks).set({
        ...taskPatch,
        version: sql`${tasks.version} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(tasks.workspaceId, input.workspaceId),
        eq(tasks.id, input.taskId),
        eq(tasks.version, input.expectedVersion),
      )).returning();
      if (!after) throw new Error("task is stale or missing");

      let afterChecklist = beforeChecklist;
      if (checklist !== undefined) {
        await tx.delete(taskChecklistItems).where(and(
          eq(taskChecklistItems.workspaceId, input.workspaceId),
          eq(taskChecklistItems.taskId, input.taskId),
        ));
        if (checklist.length) {
          await tx.insert(taskChecklistItems).values(checklist.map((item, index) => ({
            workspaceId: input.workspaceId, taskId: input.taskId, text: item.text, done: item.done, sortOrder: index,
          })));
        }
        afterChecklist = checklist;
      }

      await tx.insert(taskEvents).values({
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        actorUserId: input.actorUserId,
        eventType: "task:updated",
      });
      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        actionType: "update_task",
        entityType: "task",
        entityId: input.taskId,
        postVersion: after.version,
        beforeState: { ...taskMutableState(before), checklist: beforeChecklist },
        afterState: { ...taskMutableState(after), checklist: afterChecklist },
      });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return {
        groupId: input.groupId, count: 1, titles: [after.title],
        ...(before.title !== after.title ? { renamedFrom: before.title } : {}),
        changes: taskFieldChanges({ ...taskMutableState(before), checklist: beforeChecklist }, { ...taskMutableState(after), checklist: afterChecklist }),
      };
    });
  }

  async applyCompleteOccurrence(input: {
    workspaceId: string;
    groupId: string;
    actorUserId: string;
    occurrenceId: string;
    expectedVersion: number;
    now: Date;
    undoExpiresAt: Date;
  }): Promise<MutationAppliedResult> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx.select({ task: tasks, occurrence: taskOccurrences })
        .from(taskOccurrences)
        .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
        .where(and(
          eq(taskOccurrences.workspaceId, input.workspaceId),
          eq(taskOccurrences.id, input.occurrenceId),
          eq(taskOccurrences.version, input.expectedVersion),
        )).limit(1);
      if (!row) throw new Error("occurrence is stale or missing");

      const transition = validateOccurrenceTransition(row.occurrence.status, "done", {
        kind: row.task.kind,
        recurring: Boolean(row.task.recurrenceRule),
        now: input.now,
        ...(row.occurrence.plannedStartAt ? { plannedStartAt: row.occurrence.plannedStartAt } : {}),
        ...(row.occurrence.plannedEndAt ? { plannedEndAt: row.occurrence.plannedEndAt } : {}),
        eventElapseGraceMinutes: 15,
        explicitUserAction: true,
        systemExpire: false,
      });
      if (!transition.ok) throw new Error(transition.reason);

      const [updatedOccurrence] = await tx.update(taskOccurrences).set({
        status: "done",
        completedAt: input.now,
        completedLate: row.occurrence.status === "elapsed",
        version: sql`${taskOccurrences.version} + 1`,
        updatedAt: input.now,
      }).where(and(
        eq(taskOccurrences.workspaceId, input.workspaceId),
        eq(taskOccurrences.id, input.occurrenceId),
        eq(taskOccurrences.version, input.expectedVersion),
      )).returning();
      if (!updatedOccurrence) throw new Error("occurrence is stale or missing");

      await tx.update(reminderDeliveries).set({
        status: "suppressed",
        suppressedReason: "no_longer_applicable",
      }).where(and(
        eq(reminderDeliveries.workspaceId, input.workspaceId),
        eq(reminderDeliveries.occurrenceId, input.occurrenceId),
        inArray(reminderDeliveries.status, ["pending", "processing"]),
      ));

      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        actionType: "complete_occurrence",
        entityType: "occurrence",
        entityId: input.occurrenceId,
        postVersion: updatedOccurrence.version,
        beforeState: occurrenceMutableState(row.occurrence),
        afterState: occurrenceMutableState(updatedOccurrence),
      });

      if (!row.task.recurrenceRule) {
        const [updatedTask] = await tx.update(tasks).set({
          status: "closed",
          version: sql`${tasks.version} + 1`,
          updatedAt: input.now,
        }).where(and(
          eq(tasks.workspaceId, input.workspaceId),
          eq(tasks.id, row.task.id),
          eq(tasks.version, row.task.version),
        )).returning();
        if (!updatedTask) throw new Error("task changed while completing occurrence");
        await tx.insert(actionEvents).values({
          workspaceId: input.workspaceId,
          groupId: input.groupId,
          actionType: "complete_occurrence",
          entityType: "task",
          entityId: row.task.id,
          postVersion: updatedTask.version,
          beforeState: taskMutableState(row.task),
          afterState: taskMutableState(updatedTask),
        });
      }

      await tx.insert(taskEvents).values({
        workspaceId: input.workspaceId,
        taskId: row.task.id,
        occurrenceId: input.occurrenceId,
        actorUserId: input.actorUserId,
        eventType: "occurrence:done",
      });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: [row.task.title] };
    });
  }

  async applyRescheduleOccurrence(input: {
    workspaceId: string;
    groupId: string;
    actorUserId: string;
    occurrenceId: string;
    expectedVersion: number;
    scheduleTimezone: string;
    schedule: RescheduleFields;
    reason?: string;
    now: Date;
    undoExpiresAt: Date;
  }): Promise<MutationAppliedResult> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx.select({ task: tasks, occurrence: taskOccurrences })
        .from(taskOccurrences)
        .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
        .where(and(
          eq(taskOccurrences.workspaceId, input.workspaceId),
          eq(taskOccurrences.id, input.occurrenceId),
          eq(taskOccurrences.version, input.expectedVersion),
        )).limit(1);
      if (!row) throw new Error("occurrence is stale or missing");
      if (["done", "skipped", "cancelled", "elapsed"].includes(row.occurrence.status)) throw new Error("terminal occurrence cannot be rescheduled");
      if (input.scheduleTimezone !== row.occurrence.timezone) throw new Error("reschedule timezone must match the occurrence timezone");

      const previousReschedules = await tx.select({ id: taskEvents.id }).from(taskEvents).where(and(
        eq(taskEvents.workspaceId, input.workspaceId),
        eq(taskEvents.occurrenceId, input.occurrenceId),
        eq(taskEvents.eventType, "occurrence:rescheduled"),
      ));
      if (isRescheduleReasonRequired(row.task.importance, previousReschedules.length) && !input.reason?.trim()) {
        throw new Error("reschedule reason is required");
      }

      const currentDefinition = taskDefinitionFromRow(row.task);
      const nextDefinition = rescheduledDefinition(currentDefinition, input.schedule);
      const becomesFuzzy = nextDefinition.timeMode === "fuzzy";
      if (becomesFuzzy && row.task.recurrenceRule) throw new Error("recurring occurrence cannot become fuzzy");
      const nextStatus = becomesFuzzy ? "cancelled" : rescheduledOccurrenceStatus(nextDefinition, input.now);

      // A one-time task may return to planning without inventing a date. We keep the old
      // occurrence only as terminal history so sent reminders/audit remain referentially
      // intact; the fuzzy task has no active occurrence and its review reminder is task-level.
      const [updatedOccurrence] = await tx.update(taskOccurrences).set({
        status: nextStatus,
        timezone: input.scheduleTimezone,
        ...(becomesFuzzy ? {} : {
          plannedStartAt: input.schedule.plannedStartAt ?? null,
          plannedEndAt: input.schedule.plannedEndAt ?? null,
          plannedLocalDate: input.schedule.plannedLocalDate ?? null,
          dueAt: input.schedule.dueAt ?? null,
          dueLocalDate: input.schedule.dueLocalDate ?? null,
        }),
        overdue: false,
        elapsedAt: null,
        completedAt: null,
        completedLate: false,
        ...(becomesFuzzy ? { skipReason: "rescheduled_to_fuzzy", needsReminderRebuild: false } : { skipReason: null, needsReminderRebuild: true }),
        version: sql`${taskOccurrences.version} + 1`,
        updatedAt: input.now,
      }).where(and(
        eq(taskOccurrences.workspaceId, input.workspaceId),
        eq(taskOccurrences.id, input.occurrenceId),
        eq(taskOccurrences.version, input.expectedVersion),
      )).returning();
      if (!updatedOccurrence) throw new Error("occurrence is stale or missing");

      await tx.update(reminderDeliveries).set({ status: "cancelled", suppressedReason: "superseded" }).where(and(
        eq(reminderDeliveries.workspaceId, input.workspaceId),
        eq(reminderDeliveries.occurrenceId, input.occurrenceId),
        inArray(reminderDeliveries.status, ["pending", "processing"]),
      ));
      const followUps = await tx.select({ id: reminderRules.id }).from(reminderRules).where(and(
        eq(reminderRules.workspaceId, input.workspaceId),
        eq(reminderRules.occurrenceId, input.occurrenceId),
        eq(reminderRules.purpose, "follow_up"),
        eq(reminderRules.active, true),
      ));
      if (followUps.length) await tx.update(reminderRules).set({ active: false }).where(and(eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, followUps.map((item) => item.id))));

      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        actionType: "reschedule_occurrence",
        entityType: "occurrence",
        entityId: input.occurrenceId,
        postVersion: updatedOccurrence.version,
        beforeState: occurrenceMutableState(row.occurrence),
        afterState: occurrenceMutableState(updatedOccurrence),
      });

      if (!row.task.recurrenceRule) {
        const [updatedTask] = await tx.update(tasks).set({
          timeMode: nextDefinition.timeMode,
          timezone: nextDefinition.timezone,
          plannedStartAt: nextDefinition.plannedStartAt ?? null,
          plannedEndAt: nextDefinition.plannedEndAt ?? null,
          plannedLocalDate: nextDefinition.plannedLocalDate ?? null,
          dueAt: nextDefinition.dueAt ?? null,
          dueLocalDate: nextDefinition.dueLocalDate ?? null,
          fuzzyHorizonText: nextDefinition.fuzzyHorizonText ?? null,
          reviewAt: nextDefinition.reviewAt ?? null,
          version: sql`${tasks.version} + 1`,
          updatedAt: input.now,
        }).where(and(
          eq(tasks.workspaceId, input.workspaceId),
          eq(tasks.id, row.task.id),
          eq(tasks.version, row.task.version),
        )).returning();
        if (!updatedTask) throw new Error("task changed while rescheduling occurrence");
        await tx.insert(actionEvents).values({
          workspaceId: input.workspaceId,
          groupId: input.groupId,
          actionType: "reschedule_occurrence",
          entityType: "task",
          entityId: row.task.id,
          postVersion: updatedTask.version,
          beforeState: taskMutableState(row.task),
          afterState: taskMutableState(updatedTask),
        });
      }

      await tx.insert(taskEvents).values({
        workspaceId: input.workspaceId,
        taskId: row.task.id,
        occurrenceId: input.occurrenceId,
        actorUserId: input.actorUserId,
        eventType: "occurrence:rescheduled",
        ...(input.reason?.trim() ? { details: input.reason.trim() } : {}),
      });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return {
        groupId: input.groupId,
        count: 1,
        titles: [row.task.title],
        reminderRebuildOccurrenceId: input.occurrenceId,
        previousSchedule: {
          timezone: row.occurrence.timezone,
          plannedStartAt: row.occurrence.plannedStartAt,
          plannedEndAt: row.occurrence.plannedEndAt,
          plannedLocalDate: row.occurrence.plannedLocalDate,
          dueAt: row.occurrence.dueAt,
          dueLocalDate: row.occurrence.dueLocalDate,
        },
        occurrenceSchedule: {
          timezone: updatedOccurrence.timezone,
          plannedStartAt: updatedOccurrence.plannedStartAt,
          plannedEndAt: updatedOccurrence.plannedEndAt,
          plannedLocalDate: updatedOccurrence.plannedLocalDate,
          dueAt: updatedOccurrence.dueAt,
          dueLocalDate: updatedOccurrence.dueLocalDate,
        },
      };
    });
  }

  async applyChangeReminder(input: {
    workspaceId: string;
    groupId: string;
    actorUserId: string;
    occurrenceId: string;
    expectedVersion: number;
    mode: "add" | "replace" | "clear";
    rule?: ReminderRuleSpec;
    undoExpiresAt: Date;
  }): Promise<MutationAppliedResult> {
    return this.database.db.transaction(async (tx) => {
      const [row] = await tx.select({ task: tasks, occurrence: taskOccurrences }).from(taskOccurrences)
        .innerJoin(tasks, and(eq(tasks.workspaceId, taskOccurrences.workspaceId), eq(tasks.id, taskOccurrences.taskId)))
        .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, input.occurrenceId), eq(taskOccurrences.version, input.expectedVersion))).limit(1);
      if (!row) throw new Error("occurrence is stale or missing");
      if (["done", "skipped", "cancelled", "elapsed"].includes(row.occurrence.status)) throw new Error("terminal occurrence cannot change reminders");

      const explicit = await tx.select({ id: reminderRules.id }).from(reminderRules).where(and(
        eq(reminderRules.workspaceId, input.workspaceId), eq(reminderRules.occurrenceId, input.occurrenceId),
        eq(reminderRules.origin, "explicit"), eq(reminderRules.active, true),
      ));
      const beforeRuleIds = explicit.map((item) => item.id);
      if (input.mode !== "add" && beforeRuleIds.length) await tx.update(reminderRules).set({ active: false }).where(and(eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, beforeRuleIds)));
      if (input.mode !== "add" && beforeRuleIds.length) await tx.update(reminderDeliveries).set({ status: "cancelled", suppressedReason: "superseded" }).where(and(
        eq(reminderDeliveries.workspaceId, input.workspaceId), eq(reminderDeliveries.occurrenceId, input.occurrenceId),
        inArray(reminderDeliveries.status, ["pending", "processing"]), inArray(reminderDeliveries.reminderRuleId, beforeRuleIds),
      ));

      let insertedRuleId: string | null = null;
      if (input.mode !== "clear") {
        if (!input.rule) throw new Error("reminder rule is required");
        insertedRuleId = crypto.randomUUID();
        await tx.insert(reminderRules).values({
          id: insertedRuleId, workspaceId: input.workspaceId, taskId: row.task.id, occurrenceId: input.occurrenceId,
          triggerKind: input.rule.triggerKind,
          ...(input.rule.exactAt ? { exactAt: input.rule.exactAt } : {}),
          ...(input.rule.anchor ? { anchor: input.rule.anchor } : {}),
          ...(input.rule.offsetSeconds !== undefined ? { offsetSeconds: input.rule.offsetSeconds } : {}),
          ...(input.rule.daysOffset !== undefined ? { daysOffset: input.rule.daysOffset } : {}),
          ...(input.rule.localTime ? { localTime: input.rule.localTime } : {}),
          purpose: input.rule.purpose, quietPolicy: input.rule.quietPolicy, origin: "explicit",
        });
      }
      const afterRuleIds = input.mode === "add"
        ? [...beforeRuleIds, ...(insertedRuleId ? [insertedRuleId] : [])]
        : insertedRuleId ? [insertedRuleId] : [];

      await tx.update(reminderDeliveries).set({ status: "cancelled", suppressedReason: "superseded" }).where(and(
        eq(reminderDeliveries.workspaceId, input.workspaceId), eq(reminderDeliveries.occurrenceId, input.occurrenceId), inArray(reminderDeliveries.status, ["pending", "processing"]),
      ));
      const [after] = await tx.update(taskOccurrences).set({
        needsReminderRebuild: true,
        defaultRemindersSuppressed: input.mode === "add" ? row.occurrence.defaultRemindersSuppressed : true,
        version: sql`${taskOccurrences.version} + 1`,
        updatedAt: new Date(),
      })
        .where(and(eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, input.occurrenceId), eq(taskOccurrences.version, input.expectedVersion))).returning();
      if (!after) throw new Error("occurrence changed while updating reminder");

      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId, groupId: input.groupId, actionType: "change_reminder", entityType: "occurrence", entityId: input.occurrenceId,
        postVersion: after.version,
        beforeState: { ...occurrenceMutableState(row.occurrence), explicitReminderRuleIds: beforeRuleIds },
        afterState: { ...occurrenceMutableState(after), explicitReminderRuleIds: afterRuleIds },
      });
      await tx.insert(taskEvents).values({ workspaceId: input.workspaceId, taskId: row.task.id, occurrenceId: input.occurrenceId, actorUserId: input.actorUserId, eventType: "reminder:changed" });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return {
        groupId: input.groupId,
        count: 1,
        titles: [row.task.title],
        reminderRebuildOccurrenceId: input.occurrenceId,
        occurrenceSchedule: {
          timezone: after.timezone,
          plannedStartAt: after.plannedStartAt,
          plannedEndAt: after.plannedEndAt,
          plannedLocalDate: after.plannedLocalDate,
          dueAt: after.dueAt,
          dueLocalDate: after.dueLocalDate,
        },
      };
    });
  }

  async applyChangeSeries(input: {
    workspaceId: string; groupId: string; actorUserId: string; taskId: string; expectedVersion: number;
    operation: "pause" | "resume" | "stop" | "cancel" | "edit"; editDefinition?: TaskDefinition; now: Date; undoExpiresAt: Date;
  }): Promise<MutationAppliedResult> {
    return this.database.db.transaction(async (tx) => {
      const [task] = await tx.select().from(tasks).where(and(
        eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, input.taskId), eq(tasks.version, input.expectedVersion),
      )).limit(1);
      if (!task) throw new Error("series task is stale or missing");
      if (!task.recurrenceRule && input.operation !== "resume") throw new Error("task is not a recurring series");
      if (input.operation === "resume" && (task.status !== "paused" || !task.recurrenceRule)) throw new Error("only a paused recurring series can resume");
      if (input.operation === "edit" && !input.editDefinition) throw new Error("series edit definition is required");

      const beforeExclusions = await tx.select({ localDate: taskRecurrenceExclusions.localDate }).from(taskRecurrenceExclusions).where(and(
        eq(taskRecurrenceExclusions.workspaceId, input.workspaceId), eq(taskRecurrenceExclusions.taskId, input.taskId),
      ));

      const occurrences = await tx.select().from(taskOccurrences).where(and(
        eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.taskId, input.taskId),
      ));
      const hasCurrent = occurrences.some((row) =>
        ["open", "in_progress"].includes(row.status) && (row.status === "in_progress" || !occurrenceStillFuture(row, input.now)),
      );
      const parentStatus = input.operation === "edit"
        ? task.status
        : seriesOperationState(input.operation, hasCurrent).parentStatus;

      const taskPatch: Partial<typeof tasks.$inferInsert> = { status: parentStatus, updatedAt: input.now };
      if (input.operation === "stop") {
        taskPatch.recurrenceRule = null; taskPatch.recurrenceTimezone = null; taskPatch.recurrenceEndLocalDate = null; taskPatch.missPolicy = null;
      }
      if (input.operation === "edit") {
        const definition = input.editDefinition!;
        taskPatch.timezone = definition.timezone;
        taskPatch.plannedStartAt = definition.plannedStartAt ?? null;
        taskPatch.plannedEndAt = definition.plannedEndAt ?? null;
        taskPatch.plannedLocalDate = definition.plannedLocalDate ?? null;
        taskPatch.dueAt = definition.dueAt ?? null;
        taskPatch.dueLocalDate = definition.dueLocalDate ?? null;
        taskPatch.recurrenceRule = definition.recurrenceRule!;
        taskPatch.recurrenceTimezone = definition.recurrenceTimezone!;
        taskPatch.recurrenceEndLocalDate = definition.recurrenceEndLocalDate ?? null;
        taskPatch.missPolicy = definition.missPolicy ?? null;
        taskPatch.seriesRevision = task.seriesRevision + 1;
      }

      const [afterTask] = await tx.update(tasks).set({
        ...taskPatch, version: sql`${tasks.version} + 1`,
      }).where(and(
        eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, input.taskId), eq(tasks.version, input.expectedVersion),
      )).returning();
      if (!afterTask) throw new Error("series task changed");
      if (input.operation === "stop" || input.operation === "edit") {
        await tx.delete(taskRecurrenceExclusions).where(and(
          eq(taskRecurrenceExclusions.workspaceId, input.workspaceId), eq(taskRecurrenceExclusions.taskId, input.taskId),
        ));
        if (input.operation === "edit" && input.editDefinition?.recurrenceExcludedLocalDates?.length) {
          await tx.insert(taskRecurrenceExclusions).values(input.editDefinition.recurrenceExcludedLocalDates.map((localDate) => ({
            workspaceId: input.workspaceId, taskId: input.taskId, localDate,
          })));
        }
      }
      const afterExcludedDates = input.operation === "edit"
        ? [...(input.editDefinition?.recurrenceExcludedLocalDates ?? [])]
        : input.operation === "stop" ? [] : beforeExclusions.map((row) => row.localDate);
      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId, groupId: input.groupId, actionType: "change_series", entityType: "task", entityId: task.id,
        postVersion: afterTask.version,
        beforeState: taskMutableState(task, beforeExclusions.map((row) => row.localDate)),
        afterState: taskMutableState(afterTask, afterExcludedDates),
      });

      for (const occurrence of occurrences) {
        const future = occurrenceStillFuture(occurrence, input.now);
        const nonterminal = ["scheduled", "open", "in_progress"].includes(occurrence.status);
        let nextStatus: typeof occurrence.status | null = null;
        let skipReason: string | null = occurrence.skipReason;

        if (input.operation === "pause" && future && nonterminal && occurrence.status !== "in_progress") {
          nextStatus = "cancelled"; skipReason = "series_paused_projection";
        }
        if (input.operation === "stop" && future && nonterminal && occurrence.status !== "in_progress") {
          nextStatus = "cancelled"; skipReason = "series_stopped_projection";
        }
        if (input.operation === "edit" && future && nonterminal && occurrence.status !== "in_progress") {
          nextStatus = "cancelled"; skipReason = "series_edited_projection";
        }
        if (input.operation === "cancel" && nonterminal) {
          nextStatus = "cancelled"; skipReason = "series_cancelled";
        }
        if (input.operation === "resume" && occurrence.status === "cancelled" && occurrence.skipReason === "series_paused_projection" && future) {
          nextStatus = restoredFutureStatus(occurrence, task); skipReason = null;
        }
        if (!nextStatus || nextStatus === occurrence.status) continue;

        const [afterOccurrence] = await tx.update(taskOccurrences).set({
          status: nextStatus, skipReason, version: sql`${taskOccurrences.version} + 1`, updatedAt: input.now,
        }).where(and(
          eq(taskOccurrences.workspaceId, input.workspaceId), eq(taskOccurrences.id, occurrence.id), eq(taskOccurrences.version, occurrence.version),
        )).returning();
        if (!afterOccurrence) throw new Error("series occurrence changed");
        await tx.insert(actionEvents).values({
          workspaceId: input.workspaceId, groupId: input.groupId, actionType: "change_series", entityType: "occurrence", entityId: occurrence.id,
          postVersion: afterOccurrence.version, beforeState: occurrenceMutableState(occurrence), afterState: occurrenceMutableState(afterOccurrence),
        });
        await tx.update(reminderDeliveries).set({ status: "cancelled", suppressedReason: "superseded" }).where(and(
          eq(reminderDeliveries.workspaceId, input.workspaceId), eq(reminderDeliveries.occurrenceId, occurrence.id),
          inArray(reminderDeliveries.status, ["pending", "processing"]),
        ));
      }

      await tx.insert(taskEvents).values({
        workspaceId: input.workspaceId, taskId: task.id, actorUserId: input.actorUserId, eventType: `series:${input.operation}`,
      });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      const shouldReconcile = input.operation === "resume" || (input.operation === "edit" && afterTask.status === "active");
      return { groupId: input.groupId, count: 1, titles: [task.title], ...(shouldReconcile ? { recurrenceReconcileTaskId: task.id } : {}) };
    });
  }

  async undoMutationGroup(input: {
    workspaceId: string;
    groupId: string;
    events: Array<{ entityType: string; entityId: string; postVersion: number | null; beforeState: unknown; actionType: string }>;
    now: Date;
  }): Promise<{ reminderRebuildOccurrenceIds: string[]; recurrenceReconcileTaskIds: string[] }> {
    return this.database.db.transaction(async (tx) => {
      const rebuild = new Set<string>();
      const reconcileTasks = new Set<string>();
      for (const event of [...input.events].reverse()) {
        if (event.postVersion === null || !event.beforeState || typeof event.beforeState !== "object") throw new Error("undo state is incomplete");
        if (event.entityType === "settings") {
          const state = event.beforeState as ReturnType<typeof settingsMutableState>;
          const [restored] = await tx.update(userSettings).set({
            timezone: state.timezone, digestTimezone: state.digestTimezone, quietHoursTimezone: state.quietHoursTimezone,
            pinnedLanguage: state.pinnedLanguage, quietHoursEnabled: state.quietHoursEnabled,
            weekdayQuietStart: state.weekdayQuietStart, weekdayQuietEnd: state.weekdayQuietEnd,
            weekendQuietStart: state.weekendQuietStart, weekendQuietEnd: state.weekendQuietEnd,
            notificationsSnoozedUntil: parseJsonDate(state.notificationsSnoozedUntil),
            morningReferenceTime: state.morningReferenceTime, eveningReferenceTime: state.eveningReferenceTime,
            morningDigestEnabled: state.morningDigestEnabled, eveningDigestEnabled: state.eveningDigestEnabled,
            weeklyReviewEnabled: state.weeklyReviewEnabled, weeklyReviewWeekday: state.weeklyReviewWeekday, weeklyReviewTime: state.weeklyReviewTime,
            eventReminderOffsetsMinutes: state.eventReminderOffsetsMinutes,
            plannedTaskReminderOffsetMinutes: state.plannedTaskReminderOffsetMinutes, criticalPostDueMinutes: state.criticalPostDueMinutes,
            seenNormalMinutes: state.seenNormalMinutes, seenRequiredMinutes: state.seenRequiredMinutes, seenCriticalMinutes: state.seenCriticalMinutes,
            version: sql`${userSettings.version} + 1`, updatedAt: input.now,
          }).where(and(eq(userSettings.userId, event.entityId), eq(userSettings.version, event.postVersion))).returning({ userId: userSettings.userId });
          if (!restored) throw new Error("undo target settings changed after action");
          continue;
        }
        if (event.entityType === "task") {
          const state = event.beforeState as ReturnType<typeof taskMutableState>;
          if (event.actionType === "change_series") {
            const newerRevision = await tx.select().from(taskOccurrences).where(and(
              eq(taskOccurrences.workspaceId, input.workspaceId),
              eq(taskOccurrences.taskId, event.entityId),
              sql`${taskOccurrences.seriesRevision} <> ${state.seriesRevision}`,
              inArray(taskOccurrences.status, ["scheduled", "open", "in_progress"]),
            ));
            if (newerRevision.some((row) => row.version !== 1 || row.status === "in_progress")) {
              throw new Error("undo blocked because a new-series occurrence changed after the edit");
            }
            if (newerRevision.length) {
              const ids = newerRevision.map((row) => row.id);
              await tx.update(taskOccurrences).set({
                status: "cancelled", skipReason: "series_edit_undone", version: sql`${taskOccurrences.version} + 1`, updatedAt: input.now,
              }).where(and(eq(taskOccurrences.workspaceId, input.workspaceId), inArray(taskOccurrences.id, ids)));
              await tx.update(reminderDeliveries).set({ status: "cancelled", suppressedReason: "superseded" }).where(and(
                eq(reminderDeliveries.workspaceId, input.workspaceId), inArray(reminderDeliveries.occurrenceId, ids), inArray(reminderDeliveries.status, ["pending", "processing"]),
              ));
            }
          }
          const [restored] = await tx.update(tasks).set({
            title: state.title,
            why: state.why,
            nextAction: state.nextAction,
            context: state.context,
            importance: state.importance,
            status: state.status,
            timeMode: state.timeMode,
            timezone: state.timezone,
            plannedStartAt: parseJsonDate(state.plannedStartAt),
            plannedEndAt: parseJsonDate(state.plannedEndAt),
            plannedLocalDate: state.plannedLocalDate,
            dueAt: parseJsonDate(state.dueAt),
            dueLocalDate: state.dueLocalDate,
            fuzzyHorizonText: state.fuzzyHorizonText,
            reviewAt: parseJsonDate(state.reviewAt),
            recurrenceRule: state.recurrenceRule,
            recurrenceTimezone: state.recurrenceTimezone,
            recurrenceEndLocalDate: state.recurrenceEndLocalDate,
            missPolicy: state.missPolicy,
            habitMode: state.habitMode,
            minimumAction: state.minimumAction,
            desiredAction: state.desiredAction,
            habitTrigger: state.habitTrigger,
            habitOfferSentAt: parseJsonDate(state.habitOfferSentAt),
            seriesRevision: state.seriesRevision,
            version: sql`${tasks.version} + 1`,
            updatedAt: input.now,
          }).where(and(
            eq(tasks.workspaceId, input.workspaceId),
            eq(tasks.id, event.entityId),
            eq(tasks.version, event.postVersion),
          )).returning({ id: tasks.id });
          if (!restored) throw new Error("undo target task changed after action");
          if (event.actionType === "change_series") {
            await tx.delete(taskRecurrenceExclusions).where(and(
              eq(taskRecurrenceExclusions.workspaceId, input.workspaceId), eq(taskRecurrenceExclusions.taskId, event.entityId),
            ));
            if (state.recurrenceExcludedLocalDates.length) {
              await tx.insert(taskRecurrenceExclusions).values(state.recurrenceExcludedLocalDates.map((localDate) => ({
                workspaceId: input.workspaceId, taskId: event.entityId, localDate,
              })));
            }
            reconcileTasks.add(event.entityId);
          }
          const checklist = (state as typeof state & { checklist?: Array<{ text: string; done: boolean }> }).checklist;
          if (event.actionType === "update_task" && checklist) {
            await tx.delete(taskChecklistItems).where(and(
              eq(taskChecklistItems.workspaceId, input.workspaceId),
              eq(taskChecklistItems.taskId, event.entityId),
            ));
            if (checklist.length) {
              await tx.insert(taskChecklistItems).values(checklist.map((item, index) => ({
                workspaceId: input.workspaceId, taskId: event.entityId, text: item.text, done: item.done, sortOrder: index,
              })));
            }
          }
          continue;
        }
        if (event.entityType === "occurrence") {
          const state = event.beforeState as ReturnType<typeof occurrenceMutableState> & { explicitReminderRuleIds?: string[]; systemFollowUpRuleIds?: string[] };
          if (event.actionType === "change_reminder") {
            await tx.update(reminderRules).set({ active: false }).where(and(
              eq(reminderRules.workspaceId, input.workspaceId), eq(reminderRules.occurrenceId, event.entityId), eq(reminderRules.origin, "explicit"), eq(reminderRules.active, true),
            ));
            if (state.explicitReminderRuleIds?.length) await tx.update(reminderRules).set({ active: true }).where(and(eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, state.explicitReminderRuleIds)));
            await tx.update(reminderDeliveries).set({ status: "cancelled", suppressedReason: "superseded" }).where(and(
              eq(reminderDeliveries.workspaceId, input.workspaceId), eq(reminderDeliveries.occurrenceId, event.entityId), inArray(reminderDeliveries.status, ["pending", "processing"]),
            ));
          }
          const [restored] = await tx.update(taskOccurrences).set({
            status: state.status,
            timezone: state.timezone,
            plannedStartAt: parseJsonDate(state.plannedStartAt),
            plannedEndAt: parseJsonDate(state.plannedEndAt),
            plannedLocalDate: state.plannedLocalDate,
            dueAt: parseJsonDate(state.dueAt),
            dueLocalDate: state.dueLocalDate,
            overdue: state.overdue,
            elapsedAt: parseJsonDate(state.elapsedAt),
            completedAt: parseJsonDate(state.completedAt),
            completedLate: state.completedLate,
            skipReason: state.skipReason,
            needsReminderRebuild: ["reschedule_occurrence", "change_reminder", "change_series"].includes(event.actionType) ? true : state.needsReminderRebuild,
            defaultRemindersSuppressed: state.defaultRemindersSuppressed,
            seriesRevision: state.seriesRevision,
            version: sql`${taskOccurrences.version} + 1`,
            updatedAt: input.now,
          }).where(and(
            eq(taskOccurrences.workspaceId, input.workspaceId),
            eq(taskOccurrences.id, event.entityId),
            eq(taskOccurrences.version, event.postVersion),
          )).returning({ id: taskOccurrences.id });
          if (!restored) throw new Error("undo target occurrence changed after action");
          if (event.actionType === "update_occurrence" && state.systemFollowUpRuleIds?.length) {
            await tx.update(reminderRules).set({ active: true }).where(and(
              eq(reminderRules.workspaceId, input.workspaceId), inArray(reminderRules.id, state.systemFollowUpRuleIds),
            ));
            await tx.update(reminderDeliveries).set({ status: "pending", suppressedReason: null }).where(and(
              eq(reminderDeliveries.workspaceId, input.workspaceId), eq(reminderDeliveries.occurrenceId, event.entityId),
              inArray(reminderDeliveries.reminderRuleId, state.systemFollowUpRuleIds), eq(reminderDeliveries.status, "cancelled"),
              sql`${reminderDeliveries.scheduledFor} > ${input.now}`,
            ));
          }
          if (["reschedule_occurrence", "change_reminder", "change_series"].includes(event.actionType)) rebuild.add(event.entityId);
          if (["complete_occurrence", "update_occurrence"].includes(event.actionType)) {
            await tx.update(reminderDeliveries).set({ status: "pending", suppressedReason: null }).where(and(
              eq(reminderDeliveries.workspaceId, input.workspaceId),
              eq(reminderDeliveries.occurrenceId, event.entityId),
              eq(reminderDeliveries.status, "suppressed"),
              eq(reminderDeliveries.suppressedReason, "no_longer_applicable"),
              sql`${reminderDeliveries.scheduledFor} > ${input.now}`,
            ));
          }
          continue;
        }
        throw new Error(`unsupported undo entity ${event.entityType}`);
      }

      const [updated] = await tx.update(actionGroups).set({ status: "undone", undoneAt: input.now }).where(and(
        eq(actionGroups.workspaceId, input.workspaceId),
        eq(actionGroups.id, input.groupId),
        eq(actionGroups.status, "undoing"),
      )).returning({ id: actionGroups.id });
      if (!updated) throw new Error("undo group is not in progress");
      return { reminderRebuildOccurrenceIds: [...rebuild], recurrenceReconcileTaskIds: [...reconcileTasks] };
    });
  }
}

async function finalizeGroup(tx: DbTransaction, workspaceId: string, groupId: string, undoExpiresAt: Date): Promise<void> {
  await tx.delete(pendingActions).where(and(eq(pendingActions.workspaceId, workspaceId), eq(pendingActions.groupId, groupId)));
  const [updated] = await tx.update(actionGroups).set({
    status: "applied",
    appliedAt: new Date(),
    undoExpiresAt,
  }).where(and(
    eq(actionGroups.workspaceId, workspaceId),
    eq(actionGroups.id, groupId),
    eq(actionGroups.status, "applying"),
  )).returning({ id: actionGroups.id });
  if (!updated) throw new Error("action group is not claimable as applied");
}

function taskMutableState(row: typeof tasks.$inferSelect, recurrenceExcludedLocalDates: readonly string[] = []) {
  return {
    title: row.title,
    why: row.why,
    nextAction: row.nextAction,
    context: row.context,
    importance: row.importance,
    status: row.status,
    timeMode: row.timeMode,
    timezone: row.timezone,
    plannedStartAt: row.plannedStartAt?.toISOString() ?? null,
    plannedEndAt: row.plannedEndAt?.toISOString() ?? null,
    plannedLocalDate: row.plannedLocalDate,
    dueAt: row.dueAt?.toISOString() ?? null,
    dueLocalDate: row.dueLocalDate,
    fuzzyHorizonText: row.fuzzyHorizonText,
    reviewAt: row.reviewAt?.toISOString() ?? null,
    recurrenceRule: row.recurrenceRule,
    recurrenceTimezone: row.recurrenceTimezone,
    recurrenceEndLocalDate: row.recurrenceEndLocalDate,
    recurrenceExcludedLocalDates: [...recurrenceExcludedLocalDates],
    missPolicy: row.missPolicy,
    habitMode: row.habitMode,
    minimumAction: row.minimumAction,
    desiredAction: row.desiredAction,
    habitTrigger: row.habitTrigger,
    habitOfferSentAt: row.habitOfferSentAt?.toISOString() ?? null,
    seriesRevision: row.seriesRevision,
  };
}

function settingsMutableState(row: typeof userSettings.$inferSelect) {
  return {
    timezone: row.timezone, digestTimezone: row.digestTimezone, quietHoursTimezone: row.quietHoursTimezone,
    pinnedLanguage: row.pinnedLanguage, quietHoursEnabled: row.quietHoursEnabled,
    weekdayQuietStart: row.weekdayQuietStart, weekdayQuietEnd: row.weekdayQuietEnd,
    weekendQuietStart: row.weekendQuietStart, weekendQuietEnd: row.weekendQuietEnd,
    notificationsSnoozedUntil: row.notificationsSnoozedUntil?.toISOString() ?? null,
    morningReferenceTime: row.morningReferenceTime, eveningReferenceTime: row.eveningReferenceTime,
    morningDigestEnabled: row.morningDigestEnabled, eveningDigestEnabled: row.eveningDigestEnabled,
    weeklyReviewEnabled: row.weeklyReviewEnabled, weeklyReviewWeekday: row.weeklyReviewWeekday, weeklyReviewTime: row.weeklyReviewTime,
    eventReminderOffsetsMinutes: row.eventReminderOffsetsMinutes,
    plannedTaskReminderOffsetMinutes: row.plannedTaskReminderOffsetMinutes, criticalPostDueMinutes: row.criticalPostDueMinutes,
    seenNormalMinutes: row.seenNormalMinutes, seenRequiredMinutes: row.seenRequiredMinutes, seenCriticalMinutes: row.seenCriticalMinutes,
  };
}

function occurrenceMutableState(row: typeof taskOccurrences.$inferSelect) {
  return {
    status: row.status,
    timezone: row.timezone,
    plannedStartAt: row.plannedStartAt?.toISOString() ?? null,
    plannedEndAt: row.plannedEndAt?.toISOString() ?? null,
    plannedLocalDate: row.plannedLocalDate,
    dueAt: row.dueAt?.toISOString() ?? null,
    dueLocalDate: row.dueLocalDate,
    overdue: row.overdue,
    elapsedAt: row.elapsedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    completedLate: row.completedLate,
    skipReason: row.skipReason,
    needsReminderRebuild: row.needsReminderRebuild,
    defaultRemindersSuppressed: row.defaultRemindersSuppressed,
    seriesRevision: row.seriesRevision,
  };
}

function occurrenceStillFuture(row: typeof taskOccurrences.$inferSelect, now: Date): boolean {
  const boundary = row.plannedStartAt ?? row.dueAt;
  if (boundary) return boundary > now;
  const localBoundary = row.plannedLocalDate ?? row.dueLocalDate;
  if (localBoundary) return localBoundary >= localDateAt(now, row.timezone);
  return false;
}

function restoredFutureStatus(occurrence: typeof taskOccurrences.$inferSelect, task: typeof tasks.$inferSelect): "scheduled" | "open" {
  if (task.timeMode === "deadline" && !occurrence.plannedStartAt && !occurrence.plannedLocalDate) return "open";
  return "scheduled";
}

function parseJsonDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}
