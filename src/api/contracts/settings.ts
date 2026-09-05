import { z } from "zod";
import { IsoInstantSchema, IsoWeekdayNumberSchema, LocalDateSchema, LocalTimeSchema, LocaleSchema, TEXT_LIMITS, TimezoneSchema, VersionSchema } from "./primitives.js";

/**
 * Settings: everything the settings screen and the seven settings commands touch.
 *
 * The read shape is grouped the way the screen is, not the way the row is: the flat
 * `user_settings` row has three separate timezones and eight quiet-hours columns, and reading it
 * in order is what made the bot's settings card unreadable.
 *
 * The write shape is one discriminated union over `SettingsChange` in `src/core/settings-change.ts`.
 * That is deliberate: `buildSettingsPatch` is the single validated patch builder, the deterministic
 * commands and the model's `settings` action both go through it, and a PATCH that took loose fields
 * would be a third writer with its own rules.
 */

export const QuietHoursViewSchema = z
  .object({
    enabled: z.boolean(),
    weekdayStart: LocalTimeSchema,
    weekdayEnd: LocalTimeSchema,
    weekendStart: LocalTimeSchema,
    weekendEnd: LocalTimeSchema,
    /** Named only when it differs from the profile timezone; the client shows it then. */
    timezone: TimezoneSchema,
  })
  .strict();

export const SettingsResponseSchema = z
  .object({
    version: VersionSchema,
    timezone: TimezoneSchema,
    /** Digests and quiet hours keep their own zone until the user confirms one for everything. */
    digestTimezone: TimezoneSchema,
    /** `pinnedLanguage` is the user's explicit choice; null means «follow Telegram». */
    pinnedLanguage: LocaleSchema.nullable(),
    /** The last interface language Telegram reported; the fallback when nothing is pinned. */
    telegramLanguage: z.string().max(16).nullable(),
    /** What the two above resolve to right now, by the same rule the bot uses. */
    resolvedLocale: LocaleSchema,
    morningDigest: z.object({ enabled: z.boolean(), time: LocalTimeSchema }).strict(),
    /** Not a digest: the reference hour «вечером» resolves to. */
    eveningReferenceTime: LocalTimeSchema,
    weeklyReview: z.object({ enabled: z.boolean(), weekday: IsoWeekdayNumberSchema, time: LocalTimeSchema }).strict(),
    quietHours: QuietHoursViewSchema,
    notificationsSnoozedUntil: IsoInstantSchema.nullable(),
    reminderDefaults: z
      .object({
        eventOffsetsMinutes: z.array(z.number().int()),
        plannedTaskOffsetMinutes: z.number().int(),
        criticalPostDueMinutes: z.number().int().min(15),
      })
      .strict(),
    /** Read-only: how long after a reminder the bot escalates, per importance. */
    escalationMinutes: z.object({ normal: z.number().int().min(1), required: z.number().int().min(1), critical: z.number().int().min(1) }).strict(),
    onboardingCompletedAt: IsoInstantSchema.nullable(),
    /** How many messages the AI history holds; the settings card shows it next to «очистить». */
    historyMessageCount: z.number().int().min(0),
  })
  .strict();

/**
 * The timezone question `tzapply:` asks after a zone changes. Four answers, four states, and
 * `keep` is the one the bot spells «оставить как есть» — `SettingsService.setTimezone` maps
 * `keep` to `profile_only` and `both` to `all`.
 */
export const TimezoneApplyToSchema = z.enum(["keep", "digests", "quiet", "both"]);

/** «Утром» resolves against the user's morning reference time; an explicit instant does not. */
export const SnoozeUntilSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("morning") }).strict(),
  z.object({ kind: z.literal("at"), date: LocalDateSchema, time: LocalTimeSchema }).strict(),
]);

export const SettingsChangeSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("timezone"), timezone: z.string().min(1).max(TEXT_LIMITS.timezoneQuery), applyTo: TimezoneApplyToSchema }).strict(),
  z.object({ operation: z.literal("language"), language: LocaleSchema.nullable() }).strict(),
  z.object({ operation: z.literal("digest"), kind: z.literal("morning"), enabled: z.boolean(), time: LocalTimeSchema.nullable() }).strict(),
  z.object({ operation: z.literal("digest_preset"), enabled: z.boolean() }).strict(),
  z.object({ operation: z.literal("weekly_review"), enabled: z.boolean(), weekday: IsoWeekdayNumberSchema.nullable(), time: LocalTimeSchema.nullable() }).strict(),
  z.object({ operation: z.literal("weekly_preset"), enabled: z.boolean() }).strict(),
  z
    .object({
      operation: z.literal("quiet_hours"),
      enabled: z.boolean(),
      /** One range is enough: the weekend follows the weekday range unless the user splits them. */
      weekdayStart: LocalTimeSchema.nullable(),
      weekdayEnd: LocalTimeSchema.nullable(),
      weekendStart: LocalTimeSchema.nullable(),
      weekendEnd: LocalTimeSchema.nullable(),
    })
    .strict(),
  z.object({ operation: z.literal("snooze"), until: SnoozeUntilSchema.nullable() }).strict(),
  z
    .object({
      operation: z.literal("reminder_defaults"),
      eventOffsets: z.array(z.number().int()).min(1).max(12).nullable(),
      plannedTaskOffsetMinutes: z.number().int().nullable(),
      /** At least 15 minutes (`buildSettingsPatch`). */
      criticalPostDueMinutes: z.number().int().min(15).nullable(),
    })
    .strict(),
]);

export const SettingsPatchRequestSchema = z.object({ expectedVersion: VersionSchema, change: SettingsChangeSchema }).strict();

/** A PATCH answers with the whole screen, because one change can move three fields at once. */
export const SettingsMutationResponseSchema = z.object({ settings: SettingsResponseSchema }).strict();

/** The timezone picker: a search over the IANA list, answered server-side so no tz table ships. */
export const TimezoneSearchQuerySchema = z.object({ q: z.string().min(1).max(TEXT_LIMITS.timezoneQuery) }).strict();

export const TimezoneSuggestionSchema = z
  .object({
    /** The IANA id, e.g. `Europe/Kyiv`. */
    id: TimezoneSchema,
    /** Its current UTC offset in minutes, so the list can be ordered and read without a lookup. */
    offsetMinutes: z.number().int().min(-840).max(840),
    /** Local clock time there right now; the picker shows it to confirm the guess. */
    localTime: LocalTimeSchema,
  })
  .strict();

export const TimezoneSearchResponseSchema = z.object({ suggestions: z.array(TimezoneSuggestionSchema).max(20) }).strict();

/** `POST /chat/history/clear` — what `/clear` and `history:clear` do today. */
export const ClearHistoryResponseSchema = z.object({ cleared: z.number().int().min(0) }).strict();

/**
 * Consent. Two scopes: `text` is the configured chat provider, `voice` is the transcription
 * provider. This is a pre-check that keeps the screen honest; the boundary check inside
 * `ChatService` and `TranscriptionService` stays authoritative.
 */
export const ConsentScopeSchema = z.enum(["text", "voice"]);

export const ConsentRequestSchema = z.object({ scope: ConsentScopeSchema }).strict();

export const ConsentStateSchema = z
  .object({
    scope: ConsentScopeSchema,
    granted: z.boolean(),
    provider: z.string().max(32),
    /** The version the grant is recorded against; a new version means asking again. */
    version: z.string().max(32),
  })
  .strict();

export const ConsentResponseSchema = z.object({ consents: z.array(ConsentStateSchema) }).strict();

/**
 * Account deletion. Deterministic confirmation only — the client must send the literal word, the
 * same gate `/delete_account` puts in the chat. There is deliberately no restore endpoint: the
 * guard refuses a deletion-pending user, so the app cannot reach one, and `/restore` stays a chat
 * command. The deletion screen has to say so.
 */
export const AccountDeleteRequestSchema = z.object({ confirm: z.literal("delete") }).strict();

export const AccountDeleteResponseSchema = z
  .object({
    deleteAfter: IsoInstantSchema,
    graceDays: z.number().int().min(1),
    /** True always: it is the sentence the screen must show, not a capability the app has. */
    restoreIsChatOnly: z.literal(true),
  })
  .strict();

export type QuietHoursView = z.infer<typeof QuietHoursViewSchema>;
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
export type TimezoneApplyTo = z.infer<typeof TimezoneApplyToSchema>;
export type SnoozeUntil = z.infer<typeof SnoozeUntilSchema>;
export type SettingsChange = z.infer<typeof SettingsChangeSchema>;
export type SettingsPatchRequest = z.infer<typeof SettingsPatchRequestSchema>;
export type SettingsMutationResponse = z.infer<typeof SettingsMutationResponseSchema>;
export type TimezoneSearchQuery = z.infer<typeof TimezoneSearchQuerySchema>;
export type TimezoneSuggestion = z.infer<typeof TimezoneSuggestionSchema>;
export type TimezoneSearchResponse = z.infer<typeof TimezoneSearchResponseSchema>;
export type ClearHistoryResponse = z.infer<typeof ClearHistoryResponseSchema>;
export type ConsentScope = z.infer<typeof ConsentScopeSchema>;
export type ConsentRequest = z.infer<typeof ConsentRequestSchema>;
export type ConsentState = z.infer<typeof ConsentStateSchema>;
export type ConsentResponse = z.infer<typeof ConsentResponseSchema>;
export type AccountDeleteRequest = z.infer<typeof AccountDeleteRequestSchema>;
export type AccountDeleteResponse = z.infer<typeof AccountDeleteResponseSchema>;
