import { z } from "zod";
import { IsoInstantSchema, LocalDateSchema, LocalTimeSchema, MissPolicySchema, TEXT_LIMITS, TimezoneSchema, WeekdaySchema } from "./primitives.js";

/**
 * Time, in both directions.
 *
 * **Writing.** `TaskWhenSchema` is deliberately the same four modes as `WhenSchema` in
 * `src/core/ai-contract.ts`, because `structuredScheduleFromWhen` in
 * `src/actions/action-conversion.ts` is the only compiler from a stated time to a `TaskDefinition`,
 * and a fifth mode here would mean a second one. The five schedule shapes the screens name map onto
 * the four modes like this:
 *
 * | shape                    | mode       | fields                                   | `timeMode` |
 * | ------------------------ | ---------- | ---------------------------------------- | ---------- |
 * | exact point in time      | `exact`    | `date` + `time`, `durationMinutes: null` | `point`    |
 * | window (start .. end)    | `exact`    | `date` + `time` + `durationMinutes`      | `window`   |
 * | date only, no clock time | `date`     | `date`                                   | `window`   |
 * | deadline                 | `deadline` | `date` + optional `time`                 | `deadline` |
 * | fuzzy, with a review day | `fuzzy`    | `horizonText` + `reviewDate`             | `fuzzy`    |
 *
 * So a window is an exact start plus a duration — that is what the domain stores
 * (`plannedStartAt`/`plannedEndAt`) and what the model already sends. A form that offers an end
 * time computes the duration; it does not invent a mode.
 *
 * **Reading.** `OccurrenceScheduleSchema` mirrors `OccurrenceScheduleView` in
 * `src/core/time-presentation.ts` exactly: the persisted fields, and the client decides how to word
 * them. The server does not send a rendered label, because the client dictionary is its own
 * (design.md § 7).
 */

export const TaskWhenSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("exact"),
      date: LocalDateSchema,
      time: LocalTimeSchema,
      /** Present makes it a window; `null` makes it a point in time. */
      durationMinutes: z.number().int().min(1).max(10_080).nullable(),
    })
    .strict(),
  z.object({ mode: z.literal("date"), date: LocalDateSchema }).strict(),
  z.object({ mode: z.literal("deadline"), date: LocalDateSchema, time: LocalTimeSchema.nullable() }).strict(),
  z
    .object({
      mode: z.literal("fuzzy"),
      horizonText: z.string().min(1).max(TEXT_LIMITS.fuzzyHorizon),
      reviewDate: LocalDateSchema,
    })
    .strict(),
]);

/** What a client sends to create or change a repeat; mirrors `RecurrenceSchema` in the AI contract. */
export const RecurrenceInputSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly"]),
    interval: z.number().int().min(1).max(365),
    /** Weekly only. */
    weekdays: z.array(WeekdaySchema).max(7).nullable(),
    /** Monthly only. */
    monthDays: z.array(z.number().int().min(1).max(31)).max(31).nullable(),
    /** The end date of the series; `null` is an endless repeat. */
    until: LocalDateSchema.nullable(),
    /** Dates the series skips. At most 32, distinct, inside the series (`validateTaskDefinition`). */
    skipDates: z.array(LocalDateSchema).max(TEXT_LIMITS.recurrenceExcludedDates).nullable(),
    /** Only meaningful for a task; an event has no miss policy. */
    missed: MissPolicySchema.nullable(),
  })
  .strict();

/** What a client reads back: the rule already parsed, so no RRULE parser ships to the browser. */
export const RecurrenceViewSchema = z
  .object({
    /** The stored RRULE-ish string, for round-tripping and for debugging a screen against the row. */
    rule: z.string().min(1).max(500),
    frequency: z.enum(["daily", "weekly", "monthly"]),
    interval: z.number().int().min(1).max(365),
    weekdays: z.array(WeekdaySchema),
    monthDays: z.array(z.number().int().min(1).max(31)),
    /** `BYTIME`: several clock times on one recurring day. */
    localTimes: z.array(LocalTimeSchema),
    timezone: TimezoneSchema.nullable(),
    endLocalDate: LocalDateSchema.nullable(),
    excludedLocalDates: z.array(LocalDateSchema),
    missPolicy: MissPolicySchema.nullable(),
  })
  .strict();

/** The persisted time of one occurrence. Exactly `OccurrenceScheduleView`, plus the fuzzy fields. */
export const OccurrenceScheduleSchema = z
  .object({
    timezone: TimezoneSchema,
    plannedStartAt: IsoInstantSchema.nullable(),
    plannedEndAt: IsoInstantSchema.nullable(),
    plannedLocalDate: LocalDateSchema.nullable(),
    dueAt: IsoInstantSchema.nullable(),
    dueLocalDate: LocalDateSchema.nullable(),
  })
  .strict();

/** A fuzzy task has no occurrence; its time is a horizon and the day it comes back for review. */
export const FuzzyScheduleSchema = z
  .object({
    horizonText: z.string().max(TEXT_LIMITS.fuzzyHorizon).nullable(),
    reviewAt: IsoInstantSchema.nullable(),
    timezone: TimezoneSchema,
  })
  .strict();

export type TaskWhen = z.infer<typeof TaskWhenSchema>;
export type RecurrenceInput = z.infer<typeof RecurrenceInputSchema>;
export type RecurrenceView = z.infer<typeof RecurrenceViewSchema>;
export type OccurrenceSchedule = z.infer<typeof OccurrenceScheduleSchema>;
export type FuzzySchedule = z.infer<typeof FuzzyScheduleSchema>;
