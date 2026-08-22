import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { actionEvents, actionGroups, goals, memoryItems, pendingActions, taskGoals, tasks } from "../database/schema.js";

@Injectable()
export class ContextActionsRepository {
  constructor(private readonly database: DatabaseService) {}

  async applyCreateGoal(input: {
    workspaceId: string;
    groupId: string;
    actorUserId: string;
    title: string;
    why?: string;
    targetLocalDate?: string;
    undoExpiresAt: Date;
  }) {
    return this.database.db.transaction(async (tx) => {
      const [goal] = await tx.insert(goals).values({
        workspaceId: input.workspaceId,
        createdByUserId: input.actorUserId,
        sourceActionGroupId: input.groupId,
        title: input.title,
        ...(input.why ? { why: input.why } : {}),
        ...(input.targetLocalDate ? { targetLocalDate: input.targetLocalDate } : {}),
      }).returning();
      if (!goal) throw new Error("failed to create goal");
      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        actionType: "create_goal",
        entityType: "goal",
        entityId: goal.id,
        postVersion: goal.version,
        afterState: { title: goal.title },
      });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: [goal.title] };
    });
  }

  async createGoalPlanSeed(input: { workspaceId: string; actorUserId: string; groupId: string; title: string; why?: string; targetLocalDate?: string }) {
    const [goal] = await this.database.db.insert(goals).values({
      workspaceId: input.workspaceId, createdByUserId: input.actorUserId, sourceActionGroupId: input.groupId,
      title: input.title, ...(input.why ? { why: input.why } : {}), ...(input.targetLocalDate ? { targetLocalDate: input.targetLocalDate } : {}),
    }).returning();
    if (!goal) throw new Error("failed to create goal plan seed");
    return goal;
  }

  async finalizeGoalPlan(input: { workspaceId: string; groupId: string; goal: typeof goals.$inferSelect; taskIds: readonly string[]; undoExpiresAt: Date }) {
    return this.database.db.transaction(async (tx) => {
      if (input.taskIds.length) await tx.insert(taskGoals).values(input.taskIds.map((taskId) => ({ workspaceId: input.workspaceId, taskId, goalId: input.goal.id, source: "user_explicit", confidence: 100 })));
      await tx.insert(actionEvents).values([
        { workspaceId: input.workspaceId, groupId: input.groupId, actionType: "create_goal_plan", entityType: "goal", entityId: input.goal.id, postVersion: input.goal.version, afterState: { title: input.goal.title } },
        ...input.taskIds.map((taskId) => ({ workspaceId: input.workspaceId, groupId: input.groupId, actionType: "create_goal_plan", entityType: "task", entityId: taskId, postVersion: 1, afterState: { goalId: input.goal.id } })),
        ...input.taskIds.map((taskId) => ({ workspaceId: input.workspaceId, groupId: input.groupId, actionType: "create_goal_plan", entityType: "task_goal", entityId: taskId, postVersion: null, afterState: { taskId, goalId: input.goal.id } })),
      ]);
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
    });
  }

  async discardGoalPlanSeed(workspaceId: string, goalId: string): Promise<void> {
    await this.database.db.delete(goals).where(and(eq(goals.workspaceId, workspaceId), eq(goals.id, goalId)));
  }

  async undoGoalPlan(workspaceId: string, groupId: string, goalId: string, now: Date): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx.delete(goals).where(and(eq(goals.workspaceId, workspaceId), eq(goals.id, goalId)));
      const [updated] = await tx.update(actionGroups).set({ status: "undone", undoneAt: now }).where(and(
        eq(actionGroups.workspaceId, workspaceId), eq(actionGroups.id, groupId), eq(actionGroups.status, "undoing"),
      )).returning({ id: actionGroups.id });
      if (!updated) throw new Error("undo group is not in progress");
    });
  }

  async applyUpdateGoal(input: {
    workspaceId: string; groupId: string; actorUserId: string; goalId: string; expectedVersion: number;
    patch: { title?: string; why?: string; targetLocalDate?: string; status?: "active" | "paused" | "completed" | "cancelled"; reviewEnabled?: boolean };
    now: Date; undoExpiresAt: Date;
  }) {
    return this.database.db.transaction(async (tx) => {
      const [before] = await tx.select().from(goals).where(and(
        eq(goals.workspaceId, input.workspaceId), eq(goals.id, input.goalId), eq(goals.version, input.expectedVersion),
      )).limit(1);
      if (!before) throw new Error("goal is stale or missing");
      const [after] = await tx.update(goals).set({
        ...input.patch, version: input.expectedVersion + 1, updatedAt: input.now,
      }).where(and(
        eq(goals.workspaceId, input.workspaceId), eq(goals.id, input.goalId), eq(goals.version, input.expectedVersion),
      )).returning();
      if (!after) throw new Error("goal is stale or missing");
      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId, groupId: input.groupId, actionType: "update_goal", entityType: "goal", entityId: input.goalId,
        postVersion: after.version, beforeState: goalState(before), afterState: goalState(after),
      });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: [after.title] };
    });
  }

  async applySaveMemory(input: {
    workspaceId: string;
    groupId: string;
    actorUserId: string;
    memoryType: "note" | "decision" | "preference" | "context";
    content: string;
    sensitive: boolean;
    source: "user_explicit" | "ai_inferred";
    sourceMessageId?: string;
    undoExpiresAt: Date;
  }) {
    return this.applySaveMemories({ ...input, memories: [{
      memoryType: input.memoryType, content: input.content, sensitive: input.sensitive, source: input.source,
    }] });
  }

  async applySaveMemories(input: {
    workspaceId: string;
    groupId: string;
    actorUserId: string;
    memories: Array<{
      memoryType: "note" | "decision" | "preference" | "context";
      content: string;
      sensitive: boolean;
      source: "user_explicit" | "ai_inferred";
    }>;
    sourceMessageId?: string;
    undoExpiresAt: Date;
  }) {
    return this.database.db.transaction(async (tx) => {
      const memories = await tx.insert(memoryItems).values(input.memories.map((memory) => ({
        workspaceId: input.workspaceId,
        userId: input.actorUserId,
        type: memory.memoryType,
        content: memory.content,
        sensitive: memory.sensitive,
        source: memory.source,
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      }))).returning();
      if (memories.length !== input.memories.length) throw new Error("failed to save memories");
      await tx.insert(actionEvents).values(memories.map((memory) => ({
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        actionType: "save_memory" as const,
        entityType: "memory" as const,
        entityId: memory.id,
        postVersion: memory.version,
        afterState: memoryState(memory),
      })));
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: memories.length, titles: memories.map(() => "Сохранить в память") };
    });
  }

  async applyDeleteMemory(input: {
    workspaceId: string;
    groupId: string;
    actorUserId: string;
    memoryId: string;
    expectedVersion: number;
    undoExpiresAt: Date;
  }) {
    return this.database.db.transaction(async (tx) => {
      const [memory] = await tx.select().from(memoryItems).where(and(
        eq(memoryItems.workspaceId, input.workspaceId),
        eq(memoryItems.userId, input.actorUserId),
        eq(memoryItems.id, input.memoryId),
        eq(memoryItems.version, input.expectedVersion),
      )).limit(1);
      if (!memory) throw new Error("memory is stale or missing");
      const deleted = await tx.delete(memoryItems).where(and(
        eq(memoryItems.workspaceId, input.workspaceId),
        eq(memoryItems.userId, input.actorUserId),
        eq(memoryItems.id, input.memoryId),
        eq(memoryItems.version, input.expectedVersion),
      )).returning({ id: memoryItems.id });
      if (!deleted.length) throw new Error("memory changed before deletion");
      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        actionType: "delete_memory",
        entityType: "memory",
        entityId: memory.id,
        postVersion: null,
        beforeState: memoryState(memory),
      });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: ["Удалить из памяти"] };
    });
  }

  async applyUpdateMemory(input: {
    workspaceId: string; groupId: string; actorUserId: string; memoryId: string; expectedVersion: number;
    patch: { content?: string; sensitive?: boolean }; now: Date; undoExpiresAt: Date;
  }) {
    return this.database.db.transaction(async (tx) => {
      const [before] = await tx.select().from(memoryItems).where(and(
        eq(memoryItems.workspaceId, input.workspaceId), eq(memoryItems.userId, input.actorUserId),
        eq(memoryItems.id, input.memoryId), eq(memoryItems.version, input.expectedVersion),
      )).limit(1);
      if (!before) throw new Error("memory is stale or missing");
      const [after] = await tx.update(memoryItems).set({
        ...input.patch, version: input.expectedVersion + 1, updatedAt: input.now,
      }).where(and(
        eq(memoryItems.workspaceId, input.workspaceId), eq(memoryItems.id, input.memoryId), eq(memoryItems.version, input.expectedVersion),
      )).returning();
      if (!after) throw new Error("memory is stale or missing");
      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId, groupId: input.groupId, actionType: "update_memory", entityType: "memory", entityId: before.id,
        postVersion: after.version, beforeState: memoryState(before), afterState: memoryState(after),
      });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: ["Изменить память"] };
    });
  }

  async applyLinkTaskToGoal(input: {
    workspaceId: string;
    groupId: string;
    taskId: string;
    expectedTaskVersion: number;
    goalId: string;
    expectedGoalVersion: number;
    source: "user_explicit" | "ai_inferred";
    confidence: number;
    undoExpiresAt: Date;
  }) {
    return this.database.db.transaction(async (tx) => {
      const [task] = await tx.select({ id: tasks.id, version: tasks.version, title: tasks.title }).from(tasks).where(and(
        eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, input.taskId), eq(tasks.version, input.expectedTaskVersion),
      )).limit(1);
      const [goal] = await tx.select({ id: goals.id, version: goals.version, title: goals.title }).from(goals).where(and(
        eq(goals.workspaceId, input.workspaceId), eq(goals.id, input.goalId), eq(goals.version, input.expectedGoalVersion), eq(goals.status, "active"),
      )).limit(1);
      if (!task || !goal) throw new Error("task or goal is stale or missing");
      const [link] = await tx.insert(taskGoals).values({
        workspaceId: input.workspaceId,
        taskId: task.id,
        goalId: goal.id,
        source: input.source,
        confidence: Math.round(input.confidence * 100),
      }).onConflictDoNothing().returning();
      if (!link) throw new Error("task is already linked to this goal");
      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        actionType: "link_task_to_goal",
        entityType: "task_goal",
        entityId: task.id,
        afterState: { taskId: task.id, goalId: goal.id },
      });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: [`Связать «${task.title}» с целью «${goal.title}»`] };
    });
  }

  /** Adds a link to a create-task group before that group is finalized. */
  async linkCreatedTaskToGoal(input: {
    workspaceId: string; groupId: string; taskId: string; expectedTaskVersion: number;
    goalId: string; expectedGoalVersion: number; confidence: number;
  }): Promise<string> {
    return await this.database.db.transaction(async (tx) => {
      const [task] = await tx.select({ id: tasks.id, version: tasks.version }).from(tasks).where(and(
        eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, input.taskId), eq(tasks.version, input.expectedTaskVersion),
      )).limit(1);
      const [goal] = await tx.select({ id: goals.id, version: goals.version, title: goals.title }).from(goals).where(and(
        eq(goals.workspaceId, input.workspaceId), eq(goals.id, input.goalId), eq(goals.version, input.expectedGoalVersion), eq(goals.status, "active"),
      )).limit(1);
      if (!task || !goal) throw new Error("linked goal is missing or stale");
      const [link] = await tx.insert(taskGoals).values({
        workspaceId: input.workspaceId, taskId: task.id, goalId: goal.id, source: "ai_inferred", confidence: Math.round(input.confidence * 100),
      }).onConflictDoNothing().returning();
      if (!link) throw new Error("task is already linked to this goal");
      await tx.insert(actionEvents).values({
        workspaceId: input.workspaceId, groupId: input.groupId, actionType: "link_task_to_goal", entityType: "task_goal", entityId: task.id,
        afterState: { taskId: task.id, goalId: goal.id },
      });
      return goal.title;
    });
  }

  async undoContextGroup(input: {
    workspaceId: string;
    groupId: string;
    events: Array<{ entityType: string; entityId: string; postVersion: number | null; beforeState: unknown; afterState: unknown; actionType: string }>;
    now: Date;
  }): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      for (const event of [...input.events].reverse()) {
        if (event.entityType === "goal") {
          if (event.postVersion === null) throw new Error("goal undo version missing");
          if (event.actionType === "create_goal") {
            const deleted = await tx.delete(goals).where(and(
              eq(goals.workspaceId, input.workspaceId), eq(goals.id, event.entityId), eq(goals.version, event.postVersion),
            )).returning({ id: goals.id });
            if (!deleted.length) throw new Error("goal changed after action");
          } else if (event.actionType === "update_goal") {
            const state = event.beforeState as ReturnType<typeof goalState> | null;
            if (!state) throw new Error("goal undo state is missing");
            const [restored] = await tx.update(goals).set({
              title: state.title, why: state.why, status: state.status, targetLocalDate: state.targetLocalDate, reviewEnabled: state.reviewEnabled,
              nextReviewAt: state.nextReviewAt ? new Date(state.nextReviewAt) : null, version: event.postVersion + 1, updatedAt: input.now,
            }).where(and(eq(goals.workspaceId, input.workspaceId), eq(goals.id, event.entityId), eq(goals.version, event.postVersion))).returning({ id: goals.id });
            if (!restored) throw new Error("goal changed after action");
          } else throw new Error(`unsupported goal action ${event.actionType}`);
          continue;
        }
        if (event.entityType === "memory") {
          if (event.actionType === "save_memory") {
            if (event.postVersion === null) throw new Error("memory undo version missing");
            const deleted = await tx.delete(memoryItems).where(and(
              eq(memoryItems.workspaceId, input.workspaceId), eq(memoryItems.id, event.entityId), eq(memoryItems.version, event.postVersion),
            )).returning({ id: memoryItems.id });
            if (!deleted.length) throw new Error("memory changed after action");
          } else if (event.actionType === "delete_memory") {
            const state = event.beforeState as ReturnType<typeof memoryState> | null;
            if (!state) throw new Error("deleted memory state is missing");
            await tx.insert(memoryItems).values({
              id: event.entityId,
              workspaceId: input.workspaceId,
              userId: state.userId,
              type: state.type,
              content: state.content,
              sensitive: state.sensitive,
              source: state.source,
              ...(state.sourceMessageId ? { sourceMessageId: state.sourceMessageId } : {}),
              version: state.version + 1,
              createdAt: new Date(state.createdAt),
              updatedAt: input.now,
            });
          } else if (event.actionType === "update_memory") {
            const state = event.beforeState as ReturnType<typeof memoryState> | null;
            if (!state || event.postVersion === null) throw new Error("memory undo state is missing");
            const [restored] = await tx.update(memoryItems).set({
              content: state.content, sensitive: state.sensitive, version: event.postVersion + 1, updatedAt: input.now,
            }).where(and(
              eq(memoryItems.workspaceId, input.workspaceId), eq(memoryItems.id, event.entityId), eq(memoryItems.version, event.postVersion),
            )).returning({ id: memoryItems.id });
            if (!restored) throw new Error("memory changed after action");
          } else throw new Error(`unsupported memory action ${event.actionType}`);
          continue;
        }
        if (event.entityType === "task_goal") {
          const state = event.afterState as { taskId?: string; goalId?: string } | null;
          if (!state?.taskId || !state.goalId) throw new Error("task-goal undo state is missing");
          const deleted = await tx.delete(taskGoals).where(and(
            eq(taskGoals.workspaceId, input.workspaceId), eq(taskGoals.taskId, state.taskId), eq(taskGoals.goalId, state.goalId),
          )).returning({ taskId: taskGoals.taskId });
          if (!deleted.length) throw new Error("task-goal link changed after action");
          continue;
        }
        throw new Error(`unsupported context undo entity ${event.entityType}`);
      }
      const [updated] = await tx.update(actionGroups).set({ status: "undone", undoneAt: input.now }).where(and(
        eq(actionGroups.workspaceId, input.workspaceId), eq(actionGroups.id, input.groupId), eq(actionGroups.status, "undoing"),
      )).returning({ id: actionGroups.id });
      if (!updated) throw new Error("undo group is not in progress");
    });
  }
}

type DbTransaction = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];

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

function goalState(row: typeof goals.$inferSelect) {
  return {
    title: row.title, why: row.why, status: row.status, targetLocalDate: row.targetLocalDate, reviewEnabled: row.reviewEnabled,
    nextReviewAt: row.nextReviewAt?.toISOString() ?? null,
  };
}

function memoryState(row: typeof memoryItems.$inferSelect) {
  return {
    userId: row.userId,
    type: row.type,
    content: row.content,
    sensitive: row.sensitive,
    source: row.source,
    sourceMessageId: row.sourceMessageId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}
