import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { actionEvents, goals, memoryItems, taskGoals, tasks } from "../database/schema.js";
import { insertTaskPlan, type PersistedTaskPlan } from "../tasks/tasks.repository.js";
import { finalizeGroup } from "../actions/action-group.repository.js";
import type { DbTransaction, InTx, TouchedVersion } from "../actions/action-mutations.repository.js";
import { DomainRuleError } from "../core/errors.js";

export type LinkSource = "user_explicit" | "ai_inferred";
export type MemoryType = "note" | "decision" | "preference" | "context";

interface GroupScope {
  workspaceId: string;
  groupId: string;
  actorUserId: string;
}

export interface CreateGoalInput extends GroupScope {
  title: string;
  why?: string;
  targetLocalDate?: string;
  now: Date;
}
export interface UpdateGoalInput extends GroupScope {
  goalId: string;
  expectedVersion: number;
  patch: { title?: string; why?: string; targetLocalDate?: string; status?: "active" | "paused" | "completed" | "cancelled"; reviewEnabled?: boolean };
  now: Date;
}
export interface SaveMemoryInput extends GroupScope {
  memoryType: MemoryType;
  content: string;
  sensitive: boolean;
  source: LinkSource;
  sourceMessageId?: string;
  now: Date;
}
export interface DeleteMemoryInput extends GroupScope {
  memoryId: string;
  expectedVersion: number;
  now: Date;
}
export interface UpdateMemoryInput extends GroupScope {
  memoryId: string;
  expectedVersion: number;
  patch: { content?: string; sensitive?: boolean };
  now: Date;
}
export interface LinkTaskToGoalInput extends GroupScope {
  taskId: string;
  expectedTaskVersion: number;
  goalId: string;
  expectedGoalVersion: number;
  source: LinkSource;
  confidence: number;
  now: Date;
}
export interface UnlinkTaskToGoalInput extends GroupScope {
  taskId: string;
  expectedTaskVersion: number;
  goalId: string;
  expectedGoalVersion: number;
  now: Date;
}
export interface GoalPlanInput extends GroupScope {
  goal: { title: string; why?: string; targetLocalDate?: string };
  plans: readonly PersistedTaskPlan[];
  source: LinkSource;
  now: Date;
}

export interface CreateGoalStepResult {
  kind: "create_goal";
  goalId: string;
  title: string;
}
export interface UpdateGoalStepResult {
  kind: "update_goal";
  goalId: string;
  title: string;
}
export interface SaveMemoryStepResult {
  kind: "save_memory";
  memoryId: string;
  content: string;
}
export interface UpdateMemoryStepResult {
  kind: "update_memory";
  memoryId: string;
  content: string;
}
export interface DeleteMemoryStepResult {
  kind: "delete_memory";
  memoryId: string;
  content: string;
}
export interface LinkTaskToGoalStepResult {
  kind: "link_task_to_goal";
  taskId: string;
  goalId: string;
  taskTitle: string;
  goalTitle: string;
}
export interface UnlinkTaskToGoalStepResult {
  kind: "unlink_task_to_goal";
  taskId: string;
  goalId: string;
  taskTitle: string;
  goalTitle: string;
}
export interface GoalPlanStepResult {
  kind: "goal_plan";
  goalId: string;
  goalTitle: string;
  taskIds: string[];
  taskTitles: string[];
}

/** Single-action entry points: one transaction each, the step body plus the group finalisation. */
@Injectable()
export class ContextActionsRepository {
  constructor(private readonly database: DatabaseService) {}

  async applyCreateGoal(input: Omit<CreateGoalInput, "now"> & { now?: Date; undoExpiresAt: Date }) {
    return this.database.db.transaction(async (tx) => {
      const result = await createGoalInTx(tx, { ...input, now: input.now ?? new Date() });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: [result.title] };
    });
  }

  async applyUpdateGoal(input: UpdateGoalInput & { undoExpiresAt: Date }) {
    return this.database.db.transaction(async (tx) => {
      const result = await updateGoalInTx(tx, input);
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: [result.title] };
    });
  }

  async applySaveMemory(input: Omit<SaveMemoryInput, "now"> & { now?: Date; undoExpiresAt: Date }) {
    return this.applySaveMemories({
      ...input,
      memories: [
        {
          memoryType: input.memoryType,
          content: input.content,
          sensitive: input.sensitive,
          source: input.source,
        },
      ],
    });
  }

  async applySaveMemories(
    input: GroupScope & {
      memories: Array<{ memoryType: MemoryType; content: string; sensitive: boolean; source: LinkSource }>;
      sourceMessageId?: string;
      now?: Date;
      undoExpiresAt: Date;
    },
  ) {
    return this.database.db.transaction(async (tx) => {
      const now = input.now ?? new Date();
      const results: SaveMemoryStepResult[] = [];
      for (const memory of input.memories) {
        results.push(
          await saveMemoryInTx(tx, {
            workspaceId: input.workspaceId,
            groupId: input.groupId,
            actorUserId: input.actorUserId,
            ...memory,
            ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
            now,
          }),
        );
      }
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: results.length, titles: results.map(() => "Сохранить в память") };
    });
  }

  async applyDeleteMemory(input: Omit<DeleteMemoryInput, "now"> & { now?: Date; undoExpiresAt: Date }) {
    return this.database.db.transaction(async (tx) => {
      await deleteMemoryInTx(tx, { ...input, now: input.now ?? new Date() });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: ["Удалить из памяти"] };
    });
  }

  async applyUpdateMemory(input: UpdateMemoryInput & { undoExpiresAt: Date }) {
    return this.database.db.transaction(async (tx) => {
      await updateMemoryInTx(tx, input);
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: ["Изменить память"] };
    });
  }

  async applyLinkTaskToGoal(input: Omit<LinkTaskToGoalInput, "now"> & { now?: Date; undoExpiresAt: Date }) {
    return this.database.db.transaction(async (tx) => {
      const result = await linkTaskToGoalInTx(tx, { ...input, now: input.now ?? new Date() });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: [`Связать «${result.taskTitle}» с целью «${result.goalTitle}»`] };
    });
  }

  async applyUnlinkTaskToGoal(input: Omit<UnlinkTaskToGoalInput, "now"> & { now?: Date; undoExpiresAt: Date }) {
    return this.database.db.transaction(async (tx) => {
      const result = await unlinkTaskToGoalInTx(tx, { ...input, now: input.now ?? new Date() });
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1, titles: [`Отвязать «${result.taskTitle}» от цели «${result.goalTitle}»`] };
    });
  }

  async applyGoalPlan(input: GoalPlanInput & { undoExpiresAt: Date }) {
    return this.database.db.transaction(async (tx) => {
      const result = await goalPlanInTx(tx, input);
      await finalizeGroup(tx, input.workspaceId, input.groupId, input.undoExpiresAt);
      return { groupId: input.groupId, count: 1 + result.taskIds.length, titles: [result.goalTitle, ...result.taskTitles] };
    });
  }
}

export async function createGoalInTx(tx: DbTransaction, input: CreateGoalInput): Promise<InTx<CreateGoalStepResult>> {
  const [goal] = await tx
    .insert(goals)
    .values({
      workspaceId: input.workspaceId,
      createdByUserId: input.actorUserId,
      sourceActionGroupId: input.groupId,
      title: input.title,
      ...(input.why ? { why: input.why } : {}),
      ...(input.targetLocalDate ? { targetLocalDate: input.targetLocalDate } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
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
  return { kind: "create_goal", goalId: goal.id, title: goal.title, touched: [{ entity: "goal", id: goal.id, version: goal.version }] };
}

export async function updateGoalInTx(tx: DbTransaction, input: UpdateGoalInput): Promise<InTx<UpdateGoalStepResult>> {
  const [before] = await tx
    .select()
    .from(goals)
    .where(and(eq(goals.workspaceId, input.workspaceId), eq(goals.id, input.goalId), eq(goals.version, input.expectedVersion)))
    .limit(1);
  if (!before) throw new DomainRuleError("goal is stale or missing");
  const [after] = await tx
    .update(goals)
    .set({
      ...input.patch,
      version: input.expectedVersion + 1,
      updatedAt: input.now,
    })
    .where(and(eq(goals.workspaceId, input.workspaceId), eq(goals.id, input.goalId), eq(goals.version, input.expectedVersion)))
    .returning();
  if (!after) throw new DomainRuleError("goal is stale or missing");
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "update_goal",
    entityType: "goal",
    entityId: input.goalId,
    postVersion: after.version,
    beforeState: goalState(before),
    afterState: goalState(after),
  });
  return { kind: "update_goal", goalId: after.id, title: after.title, touched: [{ entity: "goal", id: after.id, version: after.version }] };
}

export async function saveMemoryInTx(tx: DbTransaction, input: SaveMemoryInput): Promise<InTx<SaveMemoryStepResult>> {
  const [memory] = await tx
    .insert(memoryItems)
    .values({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      type: input.memoryType,
      content: input.content,
      sensitive: input.sensitive,
      source: input.source,
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!memory) throw new Error("failed to save memory");
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "save_memory",
    entityType: "memory",
    entityId: memory.id,
    postVersion: memory.version,
    afterState: memoryState(memory),
  });
  return { kind: "save_memory", memoryId: memory.id, content: memory.content, touched: [{ entity: "memory", id: memory.id, version: memory.version }] };
}

export async function deleteMemoryInTx(tx: DbTransaction, input: DeleteMemoryInput): Promise<InTx<DeleteMemoryStepResult>> {
  const [memory] = await tx
    .select()
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.workspaceId, input.workspaceId),
        eq(memoryItems.userId, input.actorUserId),
        eq(memoryItems.id, input.memoryId),
        eq(memoryItems.version, input.expectedVersion),
      ),
    )
    .limit(1);
  if (!memory) throw new DomainRuleError("memory is stale or missing");
  const deleted = await tx
    .delete(memoryItems)
    .where(
      and(
        eq(memoryItems.workspaceId, input.workspaceId),
        eq(memoryItems.userId, input.actorUserId),
        eq(memoryItems.id, input.memoryId),
        eq(memoryItems.version, input.expectedVersion),
      ),
    )
    .returning({ id: memoryItems.id });
  if (!deleted.length) throw new DomainRuleError("memory changed before deletion");
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "delete_memory",
    entityType: "memory",
    entityId: memory.id,
    postVersion: null,
    beforeState: memoryState(memory),
  });
  return { kind: "delete_memory", memoryId: memory.id, content: memory.content, touched: [] };
}

export async function updateMemoryInTx(tx: DbTransaction, input: UpdateMemoryInput): Promise<InTx<UpdateMemoryStepResult>> {
  const [before] = await tx
    .select()
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.workspaceId, input.workspaceId),
        eq(memoryItems.userId, input.actorUserId),
        eq(memoryItems.id, input.memoryId),
        eq(memoryItems.version, input.expectedVersion),
      ),
    )
    .limit(1);
  if (!before) throw new DomainRuleError("memory is stale or missing");
  const [after] = await tx
    .update(memoryItems)
    .set({
      ...input.patch,
      version: input.expectedVersion + 1,
      updatedAt: input.now,
    })
    .where(and(eq(memoryItems.workspaceId, input.workspaceId), eq(memoryItems.id, input.memoryId), eq(memoryItems.version, input.expectedVersion)))
    .returning();
  if (!after) throw new DomainRuleError("memory is stale or missing");
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "update_memory",
    entityType: "memory",
    entityId: before.id,
    postVersion: after.version,
    beforeState: memoryState(before),
    afterState: memoryState(after),
  });
  return { kind: "update_memory", memoryId: after.id, content: after.content, touched: [{ entity: "memory", id: after.id, version: after.version }] };
}

export async function linkTaskToGoalInTx(tx: DbTransaction, input: LinkTaskToGoalInput): Promise<InTx<LinkTaskToGoalStepResult>> {
  const { task, goal } = await loadLinkPair(tx, input, true);
  const [link] = await tx
    .insert(taskGoals)
    .values({
      workspaceId: input.workspaceId,
      taskId: task.id,
      goalId: goal.id,
      source: input.source,
      confidence: Math.round(input.confidence * 100),
    })
    .onConflictDoNothing()
    .returning();
  if (!link) throw new DomainRuleError("task is already linked to this goal");
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "link_task_to_goal",
    entityType: "task_goal",
    entityId: task.id,
    afterState: { taskId: task.id, goalId: goal.id, source: link.source, confidence: link.confidence },
  });
  return { kind: "link_task_to_goal", taskId: task.id, goalId: goal.id, taskTitle: task.title, goalTitle: goal.title, touched: [] };
}

export async function unlinkTaskToGoalInTx(tx: DbTransaction, input: UnlinkTaskToGoalInput): Promise<InTx<UnlinkTaskToGoalStepResult>> {
  const { task, goal } = await loadLinkPair(tx, input, false);
  const [link] = await tx
    .delete(taskGoals)
    .where(and(eq(taskGoals.workspaceId, input.workspaceId), eq(taskGoals.taskId, task.id), eq(taskGoals.goalId, goal.id)))
    .returning();
  if (!link) throw new DomainRuleError("task is not linked to this goal");
  await tx.insert(actionEvents).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    actionType: "unlink_task_to_goal",
    entityType: "task_goal",
    entityId: task.id,
    beforeState: { taskId: task.id, goalId: goal.id, source: link.source, confidence: link.confidence },
  });
  return { kind: "unlink_task_to_goal", taskId: task.id, goalId: goal.id, taskTitle: task.title, goalTitle: goal.title, touched: [] };
}

/** A goal and its first tasks in one step: goal row, every prepared task plan, and the links between them. */
export async function goalPlanInTx(tx: DbTransaction, input: GoalPlanInput): Promise<InTx<GoalPlanStepResult>> {
  const [goal] = await tx
    .insert(goals)
    .values({
      workspaceId: input.workspaceId,
      createdByUserId: input.actorUserId,
      sourceActionGroupId: input.groupId,
      title: input.goal.title,
      ...(input.goal.why ? { why: input.goal.why } : {}),
      ...(input.goal.targetLocalDate ? { targetLocalDate: input.goal.targetLocalDate } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!goal) throw new Error("failed to create goal");
  const touched: TouchedVersion[] = [{ entity: "goal", id: goal.id, version: goal.version }];
  const taskIds: string[] = [];
  const taskTitles: string[] = [];
  for (const plan of input.plans) {
    await insertTaskPlan(tx, plan);
    await tx.insert(taskGoals).values({ workspaceId: input.workspaceId, taskId: plan.task.id, goalId: goal.id, source: input.source, confidence: 100 });
    taskIds.push(plan.task.id);
    taskTitles.push(plan.task.title);
    touched.push({ entity: "task", id: plan.task.id, version: 1 });
  }
  await tx
    .insert(actionEvents)
    .values([
      {
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        actionType: "goal_plan",
        entityType: "goal",
        entityId: goal.id,
        postVersion: goal.version,
        afterState: { title: goal.title },
      },
      ...input.plans.map((plan) => ({
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        actionType: "create_task",
        entityType: "task",
        entityId: plan.task.id,
        postVersion: 1,
        afterState: { title: plan.task.title, goalId: goal.id },
      })),
      ...input.plans.map((plan) => ({
        workspaceId: input.workspaceId,
        groupId: input.groupId,
        actionType: "link_task_to_goal",
        entityType: "task_goal",
        entityId: plan.task.id,
        postVersion: null,
        afterState: { taskId: plan.task.id, goalId: goal.id, source: input.source, confidence: 100 },
      })),
    ]);
  return { kind: "goal_plan", goalId: goal.id, goalTitle: goal.title, taskIds, taskTitles, touched };
}

async function loadLinkPair(
  tx: DbTransaction,
  input: { workspaceId: string; taskId: string; expectedTaskVersion: number; goalId: string; expectedGoalVersion: number },
  requireActiveGoal: boolean,
) {
  const [task] = await tx
    .select({ id: tasks.id, version: tasks.version, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, input.workspaceId), eq(tasks.id, input.taskId), eq(tasks.version, input.expectedTaskVersion)))
    .limit(1);
  const [goal] = await tx
    .select({ id: goals.id, version: goals.version, title: goals.title })
    .from(goals)
    .where(
      and(
        eq(goals.workspaceId, input.workspaceId),
        eq(goals.id, input.goalId),
        eq(goals.version, input.expectedGoalVersion),
        ...(requireActiveGoal ? [eq(goals.status, "active")] : []),
      ),
    )
    .limit(1);
  if (!task || !goal) throw new DomainRuleError("task or goal is stale or missing");
  return { task, goal };
}

export function goalState(row: typeof goals.$inferSelect) {
  return {
    title: row.title,
    why: row.why,
    status: row.status,
    targetLocalDate: row.targetLocalDate,
    reviewEnabled: row.reviewEnabled,
    nextReviewAt: row.nextReviewAt?.toISOString() ?? null,
  };
}

export type GoalState = ReturnType<typeof goalState>;

export function memoryState(row: typeof memoryItems.$inferSelect) {
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

export type MemoryState = ReturnType<typeof memoryState>;
