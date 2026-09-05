import { z } from "zod";
import { IsoInstantSchema, LocalDateSchema, LocalTimeSchema, PageInfoSchema, PageQuerySchema, TEXT_LIMITS, TimezoneSchema, UuidSchema } from "./primitives.js";

/**
 * Reminders, both as their own screen and as the part of a task detail that says when the bot will
 * next speak. A row is a `reminder_deliveries` row joined to its task, which is what
 * `ReminderSchedulingService.listUpcoming` already returns.
 *
 * `localDate` is computed on the server with the task's own timezone, so the client can group by
 * day (the calendar the bot's `remindersText` renders) without shipping a timezone database.
 */

export const ReminderPurposeSchema = z.enum(["user_reminder", "follow_up", "planning_review"]);

export const ReminderRowSchema = z
  .object({
    deliveryId: UuidSchema,
    taskId: UuidSchema,
    occurrenceId: UuidSchema.nullable(),
    title: z.string().max(TEXT_LIMITS.title),
    scheduledFor: IsoInstantSchema,
    /** The time the reminder is *about*, before quiet hours or a snooze moved the delivery. */
    intendedFor: IsoInstantSchema,
    timezone: TimezoneSchema,
    /** `scheduledFor` as a local day in `timezone`; the day headings are grouped on this. */
    localDate: LocalDateSchema,
    purpose: ReminderPurposeSchema,
    /** True when the delivery exists only because the user pressed «отложить». */
    followUp: z.boolean(),
  })
  .strict();

export const RemindersResponseSchema = z
  .object({
    rows: z.array(ReminderRowSchema),
    page: PageInfoSchema,
    /** The user's profile timezone, for «сегодня»/«завтра» headings. */
    timezone: TimezoneSchema,
    /** Local today in `timezone`, so the client does not decide what «today» means. */
    todayLocalDate: LocalDateSchema,
    /** Set while notifications are snoozed; every row below is still scheduled, not cancelled. */
    notificationsSnoozedUntil: IsoInstantSchema.nullable(),
  })
  .strict();

export const RemindersQuerySchema = PageQuerySchema;

/** `follow:snooze:*` on a reminder card: repeat the reminder later without moving the task. */
export const ReminderSnoozeRequestSchema = z.object({ choice: z.enum(["15m", "1h"]) }).strict();

/**
 * Repeat this reminder at a time the user names. Distinct from snooze on purpose: snooze is the
 * card's two fixed offsets, repeat is the app's free choice, and neither touches the task's time.
 */
export const ReminderRepeatRequestSchema = z.object({ date: LocalDateSchema, time: LocalTimeSchema }).strict();

/** What both write endpoints answer with, so the list can be patched without a refetch. */
export const ReminderMutationResponseSchema = z
  .object({
    /** The delivery that now exists. A snooze supersedes the old one and creates a new id. */
    reminder: ReminderRowSchema.nullable(),
    /** Present when the change is reversible; feeds the Undo snackbar. */
    undoGroupId: UuidSchema.nullable(),
  })
  .strict();

/** `DELETE /reminders/:deliveryId` — what `rem:cancel` does today. */
export const ReminderCancelResponseSchema = z.object({ cancelled: z.boolean() }).strict();

/** The reminder rules attached to one task, shown on the task detail screen. */
export const TaskReminderSchema = z
  .object({
    ruleId: UuidSchema,
    purpose: ReminderPurposeSchema,
    /** `default` when it came from the user's reminder defaults, `explicit` when asked for. */
    origin: z.enum(["default", "explicit"]),
    quietPolicy: z.enum(["respect", "bypass"]),
    /** The next pending delivery of this rule, or null when nothing is queued. */
    nextAt: IsoInstantSchema.nullable(),
    label: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("exact"), at: IsoInstantSchema }).strict(),
        z.object({ kind: z.literal("offset"), anchor: z.enum(["planned_start", "planned_end", "due_at", "review_at"]), offsetMinutes: z.number().int() }).strict(),
        z.object({ kind: z.literal("local_date"), anchor: z.enum(["planned_start", "due_at"]), daysOffset: z.number().int(), localTime: LocalTimeSchema }).strict(),
      ])
      .nullable(),
  })
  .strict();

/** Writing a reminder on a task; mirrors `ReminderSchema` in `src/core/ai-contract.ts`. */
export const ReminderInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), date: LocalDateSchema, time: LocalTimeSchema, quiet: z.enum(["respect", "bypass"]) }).strict(),
  z
    .object({
      kind: z.literal("offset"),
      anchor: z.enum(["start", "end", "due"]),
      minutes: z.number().int().min(-10_080).max(10_080),
      quiet: z.enum(["respect", "bypass"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("day"),
      anchor: z.enum(["start", "due"]),
      daysOffset: z.number().int().min(-30).max(30),
      time: LocalTimeSchema,
      quiet: z.enum(["respect", "bypass"]),
    })
    .strict(),
]);

export type ReminderPurpose = z.infer<typeof ReminderPurposeSchema>;
export type ReminderRow = z.infer<typeof ReminderRowSchema>;
export type RemindersResponse = z.infer<typeof RemindersResponseSchema>;
export type RemindersQuery = z.infer<typeof RemindersQuerySchema>;
export type ReminderSnoozeRequest = z.infer<typeof ReminderSnoozeRequestSchema>;
export type ReminderRepeatRequest = z.infer<typeof ReminderRepeatRequestSchema>;
export type ReminderMutationResponse = z.infer<typeof ReminderMutationResponseSchema>;
export type ReminderCancelResponse = z.infer<typeof ReminderCancelResponseSchema>;
export type TaskReminder = z.infer<typeof TaskReminderSchema>;
export type ReminderInput = z.infer<typeof ReminderInputSchema>;
