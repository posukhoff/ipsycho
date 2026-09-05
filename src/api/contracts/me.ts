import { z } from "zod";
import { LocaleSchema, LocalDateSchema, TimezoneSchema, UuidSchema } from "./primitives.js";
import { ConsentStateSchema, SettingsResponseSchema } from "./settings.js";

/**
 * `GET /api/v1/me` — the one bootstrap call. Everything the shell needs before it renders a screen:
 * who the request resolved to, which language to speak, what today is in the user's timezone, and
 * whether the AI and its consents are usable.
 *
 * There is deliberately no Telegram identity here. The guard reads `user.id` out of verified
 * `initData` and immediately trades it for the internal uuid; the Telegram user object is never
 * logged and never echoed, so a leak of a response body is not a leak of the allowlist.
 */

export const MeAccessSchema = z
  .object({
    /** The internal user uuid, not the Telegram id. */
    userId: UuidSchema,
    workspaceId: UuidSchema,
    /** The guard refuses everything else, so this is the only value an answered request can carry. */
    status: z.literal("active"),
    /** True for the account that may mint registration invites; the app hides the rest. */
    isOwner: z.boolean(),
  })
  .strict();

export const MeAiSchema = z
  .object({
    /** `users.ai_status`: an operator can suspend AI for one account without disabling it. */
    status: z.enum(["enabled", "suspended"]),
    /** False when the deployment has no provider key; the chat then answers deterministically. */
    configured: z.boolean(),
    provider: z.string().max(32).nullable(),
    /** True while the hourly message or call limit is spent; the screen says so instead of failing. */
    rateLimited: z.boolean(),
  })
  .strict();

export const MeResponseSchema = z
  .object({
    access: MeAccessSchema,
    locale: LocaleSchema,
    timezone: TimezoneSchema,
    /** Local today in `timezone`. Every screen that says «сегодня» takes it from here. */
    todayLocalDate: LocalDateSchema,
    ai: MeAiSchema,
    consents: z.array(ConsentStateSchema),
    settings: SettingsResponseSchema,
    /** The commit the server was built from; the app footer shows it, as `/status` does in chat. */
    commit: z.string().max(64).nullable(),
    /**
     * `DELETION_GRACE_DAYS`, and it is here rather than only on `AccountDeleteResponse` because the
     * sentence it belongs to has to be read *before* the user confirms. `/delete_account` states
     * the grace period in the prompt it puts the confirm button on; a screen that could only say it
     * afterwards would be asking for an irreversible confirmation with less information than the
     * chat gives.
     */
    deletionGraceDays: z.number().int().min(1),
  })
  .strict();

export type MeAccess = z.infer<typeof MeAccessSchema>;
export type MeAi = z.infer<typeof MeAiSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
