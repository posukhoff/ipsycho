import { z } from "zod";
import {
  ImportanceSchema,
  IsoInstantSchema,
  LocalDateSchema,
  MissPolicySchema,
  OccurrenceStatusSchema,
  PageInfoSchema,
  PageQuerySchema,
  TaskKindSchema,
  TaskScopeSchema,
  TaskStatusSchema,
  TEXT_LIMITS,
  TimeModeSchema,
  TimezoneSchema,
  UuidSchema,
  VersionSchema,
} from "./primitives.js";
import { FuzzyScheduleSchema, OccurrenceScheduleSchema, RecurrenceInputSchema, RecurrenceViewSchema, TaskWhenSchema } from "./schedule.js";
import { ReminderInputSchema, TaskReminderSchema } from "./reminders.js";

/**
 * Tasks: the list, the group a list line collapses, one task's screen, and every write.
 *
 * The list DTOs are the same data `src/core/task-list-view.ts` produces and
 * `src/telegram/telegram-format.ts` renders — a row is a task plus at most one occurrence, and a
 * group is the set of rows that read as one thing. The bot draws the group as one line and pages
 * eight at a time; the app draws the same group expanded. Neither invents a field the other lacks,
 * which is the point: `groupTaskRows` stays the only implementation of the grouping.
 *
 * Two fields a thin contract would omit and every write would then need a second round trip for:
 *
 * - `version` on the occurrence and `taskVersion` on the task. `setOccurrenceStatus` and every
 *   `ActionsService` write take an expected version; without it in the list, tapping «готово» on a
 *   list row means fetching the row again first.
 * - `overdue`. `isOverdueForDisplay` answers from the maintained flag *and* the local date, because
 *   the two disagree until the minute loop catches up. The server decides once; the client renders.
 */

export const ChecklistItemSchema = z
  .object({
    /** Null when the read path could not supply one; a write replaces the list wholesale anyway. */
    id: UuidSchema.nullable(),
    text: z.string().min(1).max(TEXT_LIMITS.checklistItem),
    done: z.boolean(),
  })
  .strict();

/** One line of a list: a live occurrence, or a fuzzy task that has none. */
export const TaskListRowSchema = z
  .object({
    taskId: UuidSchema,
    taskVersion: VersionSchema,
    occurrenceId: UuidSchema.nullable(),
    /** The occurrence version, for an optimistic write straight from the list. */
    occurrenceVersion: VersionSchema.nullable(),
    title: z.string().max(TEXT_LIMITS.title),
    importance: ImportanceSchema,
    kind: TaskKindSchema,
    taskStatus: TaskStatusSchema,
    timeMode: TimeModeSchema,
    timezone: TimezoneSchema,
    occurrenceStatus: OccurrenceStatusSchema.nullable(),
    schedule: OccurrenceScheduleSchema.nullable(),
    fuzzy: FuzzyScheduleSchema.nullable(),
    /** `rowLocalDate`: the single local day this row belongs to, null for fuzzy and undated work. */
    localDate: LocalDateSchema.nullable(),
    /** `isOverdueForDisplay`, decided on the server. */
    overdue: z.boolean(),
    /** The raw repeat rule, so a row can be told apart from a one-off without parsing. */
    recurrenceRule: z.string().max(500).nullable(),
    recurrenceEndLocalDate: LocalDateSchema.nullable(),
    completedAt: IsoInstantSchema.nullable(),
    completedLate: z.boolean(),
    /** The next `user_reminder` delivery for this occurrence, from `nextUserReminderAtMany`. */
    nextReminderAt: IsoInstantSchema.nullable(),
  })
  .strict();

/**
 * A collapsed group: everything that reads as one thing. `leadIndex` points into `rows` rather than
 * repeating the lead row, so the payload does not carry it twice.
 */
export const TaskGroupSchema = z
  .object({
    /** `TaskGroup.key`: the lead occurrence id, or the task id when there is none. */
    key: z.string().min(1).max(64),
    title: z.string().max(TEXT_LIMITS.title),
    importance: ImportanceSchema,
    recurrenceRule: z.string().max(500).nullable(),
    rows: z.array(TaskListRowSchema).min(1),
    /** Index in `rows` of the row the collapsed line describes. */
    leadIndex: z.number().int().min(0),
    /** How many of `rows` are already past; the count the bot's «▸» line hides. */
    pastCount: z.number().int().min(0),
  })
  .strict();

export const TaskListQuerySchema = PageQuerySchema.extend({ scope: TaskScopeSchema.default("week") }).strict();

export const TaskListResponseSchema = z
  .object({
    scope: TaskScopeSchema,
    groups: z.array(TaskGroupSchema),
    page: PageInfoSchema,
    /** What every other filter tab would show; `scopeCounts`, for the badges. */
    counts: z.record(TaskScopeSchema, z.number().int().min(0)),
    /** Paused series live in no date window, so they get their own count and their own list. */
    pausedCount: z.number().int().min(0),
    /** Local today in the user's timezone; the client never computes it. */
    todayLocalDate: LocalDateSchema,
    timezone: TimezoneSchema,
  })
  .strict();

export const TodayResponseSchema = z
  .object({
    localDate: LocalDateSchema,
    timezone: TimezoneSchema,
    groups: z.array(TaskGroupSchema),
    page: PageInfoSchema,
    /** Work dated before today: counted here, listed under the `overdue` filter. */
    staleCount: z.number().int().min(0),
    completedCount: z.number().int().min(0),
  })
  .strict();

/** One goal a task is attached to; the detail screen shows at most one today. */
export const TaskGoalLinkSchema = z.object({ id: UuidSchema, title: z.string().max(TEXT_LIMITS.goalTitle), version: VersionSchema }).strict();

/**
 * The journal of one task: `task_events` rows. `details` is the user's own text (a reschedule
 * reason), returned to the user who wrote it and to nobody else.
 */
export const TaskJournalEntrySchema = z
  .object({
    id: UuidSchema,
    /** `occurrence:done`, `reschedule`, … — a token, rendered by the client dictionary. */
    eventType: z.string().max(64),
    occurrenceId: UuidSchema.nullable(),
    at: IsoInstantSchema,
    details: z.string().max(1000).nullable(),
    /** Null when the change was not made by a person (the expiry loop, the recurrence rebuild). */
    byUser: z.boolean(),
  })
  .strict();

export const OccurrenceDetailSchema = z
  .object({
    id: UuidSchema,
    version: VersionSchema,
    status: OccurrenceStatusSchema,
    schedule: OccurrenceScheduleSchema,
    overdue: z.boolean(),
    localDate: LocalDateSchema.nullable(),
    expiresAt: IsoInstantSchema.nullable(),
    elapsedAt: IsoInstantSchema.nullable(),
    completedAt: IsoInstantSchema.nullable(),
    completedLate: z.boolean(),
    skipReason: z.string().max(64).nullable(),
    /** The series row this occurrence belongs to, when the task repeats. */
    recurrenceKey: z.string().max(255).nullable(),
    /** True when a DST shift moved this one; the card says so rather than looking wrong. */
    dstAdjusted: z.boolean(),
  })
  .strict();

export const TaskDetailSchema = z
  .object({
    id: UuidSchema,
    version: VersionSchema,
    title: z.string().max(TEXT_LIMITS.title),
    why: z.string().max(TEXT_LIMITS.why).nullable(),
    nextAction: z.string().max(TEXT_LIMITS.nextAction).nullable(),
    context: z.string().max(TEXT_LIMITS.context).nullable(),
    kind: TaskKindSchema,
    importance: ImportanceSchema,
    status: TaskStatusSchema,
    timeMode: TimeModeSchema,
    timezone: TimezoneSchema,
    /** The occurrence this screen is about: the one the deep link named, else the current one. */
    occurrence: OccurrenceDetailSchema.nullable(),
    /** A fuzzy task has no occurrence at all; this is its horizon and review day. */
    fuzzy: FuzzyScheduleSchema.nullable(),
    recurrence: RecurrenceViewSchema.nullable(),
    /** Every other live date of the same series, so «раскрыть повтор» needs no second call. */
    siblingOccurrences: z.array(OccurrenceDetailSchema),
    checklist: z.array(ChecklistItemSchema),
    goal: TaskGoalLinkSchema.nullable(),
    reminders: z.array(TaskReminderSchema),
    nextReminderAt: IsoInstantSchema.nullable(),
    journal: z.array(TaskJournalEntrySchema),
    /** `isRescheduleReasonRequired` for this occurrence; the reschedule sheet reads it. */
    rescheduleReasonRequired: z.boolean(),
    /** Monday of the week this task was taken for, or null while it sits in the pool. */
    pickedWeekStart: LocalDateSchema.nullable(),
    /** Offered only for an endless repeat: pausing a series with an end date only loses dates. */
    canPauseSeries: z.boolean(),
    createdAt: IsoInstantSchema,
    updatedAt: IsoInstantSchema,
  })
  .strict();

/* ---------------------------------------------------------------- writes */

/**
 * The state changes a screen can make on one occurrence. The names are the app's, and the mapping
 * to `OccurrenceStatus` is the server's:
 *
 * | request     | `setOccurrenceStatus` | note                                                      |
 * | ----------- | --------------------- | --------------------------------------------------------- |
 * | `done`      | `done`                |                                                           |
 * | `started`   | `in_progress`         |                                                           |
 * | `seen`      | `open`                | acknowledged; `note` records what is blocking it          |
 * | `skipped`   | `skipped`             | recurring tasks only (`validateOccurrenceTransition`)     |
 * | `cancelled` | `cancelled`           | explicit user action only                                 |
 *
 * `elapsed` is not here: only the expiry loop may set it.
 */
export const OccurrenceStateSchema = z.enum(["done", "started", "seen", "skipped", "cancelled"]);

export const OccurrenceStateRequestSchema = z
  .object({
    state: OccurrenceStateSchema,
    expectedVersion: VersionSchema,
    /** What is blocking it. Journalled as the event's details; never required. */
    note: z.string().max(TEXT_LIMITS.blockerNote).nullable().optional(),
  })
  .strict();

/** The presets the reminder card carries, so the sheet and the card cannot drift apart. */
export const ReschedulePresetSchema = z.enum(["1h", "evening", "tomorrow"]);
/** The four buttons behind `rr:*`. `other` means the free-text `text` field carries the reason. */
export const RescheduleReasonCodeSchema = z.enum(["time", "dependency", "energy", "other"]);

export const RescheduleReasonSchema = z
  .object({
    code: RescheduleReasonCodeSchema,
    text: z.string().max(TEXT_LIMITS.rescheduleReason).nullable(),
  })
  .strict();

export const RescheduleRequestSchema = z
  .object({
    expectedVersion: VersionSchema,
    when: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("preset"), preset: ReschedulePresetSchema }).strict(),
      z.object({ kind: z.literal("custom"), when: TaskWhenSchema }).strict(),
    ]),
    /**
     * Required when `isRescheduleReasonRequired` says so — a critical or required task, or a second
     * move of the same occurrence. The server refuses without it; it does not silently accept.
     */
    reason: RescheduleReasonSchema.nullable(),
    /** `occurrence` moves this date, `series` changes the rule. Null lets the server decide. */
    scope: z.enum(["occurrence", "series"]).nullable(),
    /** Only with `scope: "series"`; null keeps the current rule. */
    recurrence: RecurrenceInputSchema.nullable(),
  })
  .strict();

/** What the reschedule sheet needs before it renders, without guessing at the rule. */
export const RescheduleOptionsSchema = z
  .object({
    reasonRequired: z.boolean(),
    presets: z.array(ReschedulePresetSchema),
    /** What each preset resolves to right now, so the button can show the time it will produce. */
    presetTimes: z.record(ReschedulePresetSchema, IsoInstantSchema),
    timezone: TimezoneSchema,
    /** True for a repeating task: the sheet then has to ask «this date or the series». */
    hasSeries: z.boolean(),
  })
  .strict();

export const TaskBodySchema = z
  .object({
    title: z.string().min(1).max(TEXT_LIMITS.title),
    why: z.string().max(TEXT_LIMITS.why).nullable(),
    nextAction: z.string().max(TEXT_LIMITS.nextAction).nullable(),
    context: z.string().max(TEXT_LIMITS.context).nullable(),
    checklist: z
      .array(z.object({ text: z.string().min(1).max(TEXT_LIMITS.checklistItem), done: z.boolean() }).strict())
      .max(TEXT_LIMITS.checklistItems)
      .nullable(),
    importance: ImportanceSchema,
    kind: TaskKindSchema,
    when: TaskWhenSchema,
    recurrence: RecurrenceInputSchema.nullable(),
    reminder: ReminderInputSchema.nullable(),
    /** Only when the user named a zone other than their own; null uses the profile timezone. */
    timezone: TimezoneSchema.nullable(),
    /** An existing goal to attach on creation. */
    goalId: UuidSchema.nullable(),
  })
  .strict();

export const CreateTaskRequestSchema = TaskBodySchema;

/**
 * A patch. `null` on a field means «leave it alone», which is why emptying one needs `clear` —
 * the same split `UpdateTaskPatchSchema` in `src/core/ai-contract.ts` makes, for the same reason.
 * A checklist is replaced wholesale; there is no per-item write, because the domain has none.
 */
export const UpdateTaskRequestSchema = z
  .object({
    expectedVersion: VersionSchema,
    title: z.string().min(1).max(TEXT_LIMITS.title).nullable(),
    why: z.string().max(TEXT_LIMITS.why).nullable(),
    nextAction: z.string().max(TEXT_LIMITS.nextAction).nullable(),
    context: z.string().max(TEXT_LIMITS.context).nullable(),
    checklist: z
      .array(z.object({ text: z.string().min(1).max(TEXT_LIMITS.checklistItem), done: z.boolean() }).strict())
      .max(TEXT_LIMITS.checklistItems)
      .nullable(),
    importance: ImportanceSchema.nullable(),
    clear: z
      .array(z.enum(["why", "nextAction", "context", "checklist"]))
      .max(4)
      .nullable(),
  })
  .strict();

/** Ticking one box is still a whole-list write; this is the shape that says so out loud. */
export const ChecklistWriteRequestSchema = z
  .object({
    expectedVersion: VersionSchema,
    items: z.array(z.object({ text: z.string().min(1).max(TEXT_LIMITS.checklistItem), done: z.boolean() }).strict()).max(TEXT_LIMITS.checklistItems),
  })
  .strict();

/** Pause or resume a whole series; both take the task version, not an occurrence version. */
export const SeriesRequestSchema = z.object({ expectedVersion: VersionSchema }).strict();

export const PausedSeriesRowSchema = z
  .object({
    taskId: UuidSchema,
    version: VersionSchema,
    title: z.string().max(TEXT_LIMITS.title),
    importance: ImportanceSchema,
    recurrence: RecurrenceViewSchema.nullable(),
    recurrenceRule: z.string().max(500).nullable(),
    recurrenceEndLocalDate: LocalDateSchema.nullable(),
    missPolicy: MissPolicySchema.nullable(),
    /** When the series was paused, so «на паузе с …» does not have to be guessed. */
    pausedAt: IsoInstantSchema.nullable(),
  })
  .strict();

export const PausedSeriesResponseSchema = z.object({ rows: z.array(PausedSeriesRowSchema), page: PageInfoSchema }).strict();

/**
 * Every write answers with the task as it now stands plus, when the change is truthfully
 * reversible, the action group Undo would roll back. `undoGroupId` is null when it is not —
 * exposing Undo for something that cannot be restored is the one thing `AGENTS.md` forbids by name.
 */
export const TaskMutationResponseSchema = z
  .object({
    task: TaskDetailSchema,
    undoGroupId: UuidSchema.nullable(),
  })
  .strict();

export const UndoRequestSchema = z.object({ groupId: UuidSchema }).strict();
export const UndoResponseSchema = z.object({ undone: z.boolean() }).strict();

export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;
export type TaskListRow = z.infer<typeof TaskListRowSchema>;
export type TaskGroup = z.infer<typeof TaskGroupSchema>;
export type TaskListQuery = z.infer<typeof TaskListQuerySchema>;
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
export type TodayResponse = z.infer<typeof TodayResponseSchema>;
export type TaskGoalLink = z.infer<typeof TaskGoalLinkSchema>;
export type TaskJournalEntry = z.infer<typeof TaskJournalEntrySchema>;
export type OccurrenceDetail = z.infer<typeof OccurrenceDetailSchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
export type OccurrenceState = z.infer<typeof OccurrenceStateSchema>;
export type OccurrenceStateRequest = z.infer<typeof OccurrenceStateRequestSchema>;
export type ReschedulePreset = z.infer<typeof ReschedulePresetSchema>;
export type RescheduleReasonCode = z.infer<typeof RescheduleReasonCodeSchema>;
export type RescheduleReason = z.infer<typeof RescheduleReasonSchema>;
export type RescheduleRequest = z.infer<typeof RescheduleRequestSchema>;
export type RescheduleOptions = z.infer<typeof RescheduleOptionsSchema>;
export type TaskBody = z.infer<typeof TaskBodySchema>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;
export type ChecklistWriteRequest = z.infer<typeof ChecklistWriteRequestSchema>;
export type SeriesRequest = z.infer<typeof SeriesRequestSchema>;
export type PausedSeriesRow = z.infer<typeof PausedSeriesRowSchema>;
export type PausedSeriesResponse = z.infer<typeof PausedSeriesResponseSchema>;
export type TaskMutationResponse = z.infer<typeof TaskMutationResponseSchema>;
export type UndoRequest = z.infer<typeof UndoRequestSchema>;
export type UndoResponse = z.infer<typeof UndoResponseSchema>;
