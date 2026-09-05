import { z } from "zod";
import { ImportanceSchema, LocalDateSchema, PageInfoSchema, PageQuerySchema, TEXT_LIMITS, TimezoneSchema, UuidSchema, VersionSchema } from "./primitives.js";

/**
 * The week plan: the pool of tasks with no day, and the handful taken for the coming week.
 *
 * The mark is the Monday of the week the pick is *for*, which is what makes a stale pick
 * unrepresentable (`src/core/week-plan.ts`). Both derived answers are computed on the server —
 * `isPickLive` and `isPickStale` need `targetWeekStart`, which needs the user's timezone, and a
 * client that recomputed them would put Sunday's pick in the wrong week for exactly one day a week.
 */

export const WeekPoolRowSchema = z
  .object({
    taskId: UuidSchema,
    version: VersionSchema,
    title: z.string().max(TEXT_LIMITS.title),
    importance: ImportanceSchema,
    /** The raw mark, so a client can show which week it names. */
    pickedWeekStart: LocalDateSchema.nullable(),
    /** `isPickLive`: taken for the week this pick is for. The checkbox reads this. */
    picked: z.boolean(),
    /** `isPickStale`: taken last week and never given a day — the decision being avoided. */
    stale: z.boolean(),
    /** A task whose day has already passed lives in the pool too; the pool is where its next day is chosen. */
    overdue: z.boolean(),
  })
  .strict();

export const WeekQuerySchema = PageQuerySchema;

export const WeekResponseSchema = z
  .object({
    /** Monday of the week a pick made today is for; on Sunday that is tomorrow's Monday. */
    targetWeekStart: LocalDateSchema,
    todayLocalDate: LocalDateSchema,
    timezone: TimezoneSchema,
    rows: z.array(WeekPoolRowSchema),
    page: PageInfoSchema,
    /** How many tasks one week may hold: `WEEK_PICK_LIMIT`. Sent so the client caps before the tap. */
    pickLimit: z.number().int().min(1),
    pickedCount: z.number().int().min(0),
    /** What the week that just ended actually did. */
    summary: z.object({ done: z.number().int().min(0), takenNotStarted: z.number().int().min(0) }).strict(),
    previousWeek: z.object({ start: LocalDateSchema, end: LocalDateSchema }).strict(),
  })
  .strict();

/**
 * The toggle behind `wk:t`. `full` is not an error: the limit is a product rule, the tap was legal,
 * and the client shows «на неделю уже взято 7» rather than a failure.
 */
export const WeekPickResponseSchema = z
  .object({
    result: z.enum(["picked", "released", "full", "not_found"]),
    targetWeekStart: LocalDateSchema,
    pickedCount: z.number().int().min(0),
    row: WeekPoolRowSchema.nullable(),
  })
  .strict();

/** `wk:d` from the morning card: give a pooled task today's date. */
export const WeekTakeTodayRequestSchema = z.object({ expectedVersion: VersionSchema }).strict();

export const WeekTakeTodayResponseSchema = z
  .object({
    taskId: UuidSchema,
    /** The occurrence the task now has, so the client can open it straight away. */
    occurrenceId: UuidSchema.nullable(),
    localDate: LocalDateSchema,
    undoGroupId: UuidSchema.nullable(),
  })
  .strict();

export type WeekPoolRow = z.infer<typeof WeekPoolRowSchema>;
export type WeekQuery = z.infer<typeof WeekQuerySchema>;
export type WeekResponse = z.infer<typeof WeekResponseSchema>;
export type WeekPickResponse = z.infer<typeof WeekPickResponseSchema>;
export type WeekTakeTodayRequest = z.infer<typeof WeekTakeTodayRequestSchema>;
export type WeekTakeTodayResponse = z.infer<typeof WeekTakeTodayResponseSchema>;
