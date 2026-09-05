import { z } from "zod";
import {
  GoalScopeSchema,
  GoalStatusSchema,
  ImportanceSchema,
  IsoInstantSchema,
  LocalDateSchema,
  PageInfoSchema,
  PageQuerySchema,
  TaskStatusSchema,
  TEXT_LIMITS,
  UuidSchema,
  VersionSchema,
} from "./primitives.js";

/**
 * Goals. The list stays scannable — one row per goal with how much of it is planned — and the tasks
 * themselves live on the goal's own screen, exactly the split `goalsOverviewText` makes today.
 *
 * `idleDays` is the one number the bot computes but never showed on this screen: `idleGoals` in
 * `src/core/goal-attention.ts` decides which goal the weekly card raises, and the app should be able
 * to mark the same goal without a second endpoint.
 */

export const GoalTaskRowSchema = z
  .object({
    taskId: UuidSchema,
    /** The occurrence to open, when the task has a live one. A fuzzy task has none. */
    occurrenceId: UuidSchema.nullable(),
    title: z.string().max(TEXT_LIMITS.title),
    /** `selectCardDetails` already drops a detail that only repeats the title; this is the survivor. */
    detail: z.string().max(TEXT_LIMITS.context).nullable(),
    dueLocalDate: LocalDateSchema.nullable(),
    importance: ImportanceSchema,
    status: TaskStatusSchema,
    overdue: z.boolean(),
  })
  .strict();

export const GoalRowSchema = z
  .object({
    id: UuidSchema,
    version: VersionSchema,
    title: z.string().max(TEXT_LIMITS.goalTitle),
    why: z.string().max(TEXT_LIMITS.goalWhy).nullable(),
    status: GoalStatusSchema,
    targetLocalDate: LocalDateSchema.nullable(),
    reviewEnabled: z.boolean(),
    nextReviewAt: IsoInstantSchema.nullable(),
    /** Active linked tasks; the list line says only how many there are. */
    taskCount: z.number().int().min(0),
    /** Days since anything moved this goal, from `idleGoals`. Null when it is not being watched. */
    idleDays: z.number().int().min(0).nullable(),
    updatedAt: IsoInstantSchema,
  })
  .strict();

export const GoalsQuerySchema = PageQuerySchema.extend({ scope: GoalScopeSchema.default("active") }).strict();

export const GoalsResponseSchema = z
  .object({
    scope: GoalScopeSchema,
    goals: z.array(GoalRowSchema),
    page: PageInfoSchema,
    /** What each tab would show, for the badges. */
    counts: z.record(GoalScopeSchema, z.number().int().min(0)),
  })
  .strict();

export const GoalDetailSchema = z.object({ goal: GoalRowSchema, tasks: z.array(GoalTaskRowSchema) }).strict();

export const CreateGoalRequestSchema = z
  .object({
    title: z.string().min(1).max(TEXT_LIMITS.goalTitle),
    why: z.string().max(TEXT_LIMITS.goalWhy).nullable(),
    targetLocalDate: LocalDateSchema.nullable(),
  })
  .strict();

export const UpdateGoalRequestSchema = z
  .object({
    expectedVersion: VersionSchema,
    title: z.string().min(1).max(TEXT_LIMITS.goalTitle).nullable(),
    why: z.string().max(TEXT_LIMITS.goalWhy).nullable(),
    targetLocalDate: LocalDateSchema.nullable(),
    status: GoalStatusSchema.nullable(),
    reviewEnabled: z.boolean().nullable(),
    clear: z
      .array(z.enum(["why", "targetLocalDate"]))
      .max(2)
      .nullable(),
  })
  .strict();

/** Link and unlink both address one (task, goal) pair and both carry the versions they read. */
export const GoalLinkRequestSchema = z
  .object({
    taskId: UuidSchema,
    expectedGoalVersion: VersionSchema,
    expectedTaskVersion: VersionSchema,
  })
  .strict();

export const GoalMutationResponseSchema = z.object({ goal: GoalDetailSchema, undoGroupId: UuidSchema.nullable() }).strict();

export type GoalTaskRow = z.infer<typeof GoalTaskRowSchema>;
export type GoalRow = z.infer<typeof GoalRowSchema>;
export type GoalsQuery = z.infer<typeof GoalsQuerySchema>;
export type GoalsResponse = z.infer<typeof GoalsResponseSchema>;
export type GoalDetail = z.infer<typeof GoalDetailSchema>;
export type CreateGoalRequest = z.infer<typeof CreateGoalRequestSchema>;
export type UpdateGoalRequest = z.infer<typeof UpdateGoalRequestSchema>;
export type GoalLinkRequest = z.infer<typeof GoalLinkRequestSchema>;
export type GoalMutationResponse = z.infer<typeof GoalMutationResponseSchema>;
