import { z } from "zod";

/**
 * The vocabulary every Mini App DTO shares.
 *
 * Two rules hold across the whole contract and are the reason this file exists:
 *
 * 1. **Instants are UTC ISO strings, local times are strings.** An instant crosses the wire as
 *    `2026-09-05T17:30:00.000Z`; a day is `YYYY-MM-DD` and a clock time is `HH:MM`, both already in
 *    the timezone the row carries. The client never converts, because the domain stores a local day
 *    and a timezone side by side and re-deriving one from the other in the browser is how a task
 *    dated «today» in Kyiv becomes yesterday's on a phone set to UTC-5.
 * 2. **Telegram used to bound every free-text field; nothing does on the web.** Every string cap
 *    here mirrors the domain's own limit (`tasks.title` 500, `TaskBodySchema` in
 *    `src/core/ai-contract.ts`), so a request that the contract accepts cannot be refused by the
 *    service for length alone.
 */

/** Free-text caps, mirroring `src/core/ai-contract.ts` and `TasksService.buildTaskPlan`. */
export const TEXT_LIMITS = {
  title: 500,
  why: 1000,
  nextAction: 500,
  context: 1000,
  checklistItem: 300,
  checklistItems: 20,
  goalTitle: 500,
  goalWhy: 1000,
  memoryContent: 2000,
  fuzzyHorizon: 200,
  rescheduleReason: 500,
  blockerNote: 500,
  timezoneQuery: 128,
  recurrenceExcludedDates: 32,
} as const;

export const UuidSchema = z.uuid();
/** Always UTC with a trailing `Z`; `z.iso.datetime()` rejects an offset by default. */
export const IsoInstantSchema = z.iso.datetime();
export const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);
export const TimezoneSchema = z.string().min(1).max(128);
/** Optimistic-concurrency version of a row; every write that can conflict carries one. */
export const VersionSchema = z.number().int().positive();

export const LocaleSchema = z.enum(["ru", "uk", "en"]);
export const ImportanceSchema = z.enum(["normal", "required", "critical"]);
export const TaskKindSchema = z.enum(["task", "event"]);
export const TaskStatusSchema = z.enum(["active", "paused", "closed", "cancelled"]);
export const TimeModeSchema = z.enum(["point", "window", "deadline", "fuzzy"]);
export const OccurrenceStatusSchema = z.enum(["scheduled", "open", "in_progress", "done", "skipped", "cancelled", "elapsed"]);
export const MissPolicySchema = z.enum(["expire", "carry_over"]);
export const GoalStatusSchema = z.enum(["active", "paused", "completed", "cancelled"]);
export const MemoryTypeSchema = z.enum(["note", "decision", "preference", "context"]);
export const WeekdaySchema = z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
/** 1 is Monday, 7 is Sunday, as `localWeekday` in `src/core/week-plan.ts` and `weeklyReviewWeekday`. */
export const IsoWeekdayNumberSchema = z.number().int().min(1).max(7);

/** The list filters of `src/core/task-list-view.ts`; `nodate` is the fuzzy pool. */
export const TaskScopeSchema = z.enum(["overdue", "today", "week", "month", "all", "nodate"]);
export const GoalScopeSchema = z.enum(["active", "paused", "completed"]);

/**
 * Paging is offset-based because the domain reads the whole set and narrows in memory
 * (`listGrouped`), so a cursor would have nothing stable to point at.
 * The app asks for larger pages than the bot's eight lines: it renders an infinite list.
 */
export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

export const PageQuerySchema = z
  .object({
    page: z.coerce.number().int().min(0).max(10_000).default(0),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export const PageInfoSchema = z
  .object({
    page: z.number().int().min(0),
    pages: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
    hasMore: z.boolean(),
  })
  .strict();

export type Locale = z.infer<typeof LocaleSchema>;
export type Importance = z.infer<typeof ImportanceSchema>;
export type TaskKind = z.infer<typeof TaskKindSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TimeMode = z.infer<typeof TimeModeSchema>;
export type OccurrenceStatus = z.infer<typeof OccurrenceStatusSchema>;
export type MissPolicy = z.infer<typeof MissPolicySchema>;
export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export type Weekday = z.infer<typeof WeekdaySchema>;
export type TaskScope = z.infer<typeof TaskScopeSchema>;
export type GoalScope = z.infer<typeof GoalScopeSchema>;
export type PageQuery = z.infer<typeof PageQuerySchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
