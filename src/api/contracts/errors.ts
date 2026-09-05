import { z } from "zod";
import { VersionSchema } from "./primitives.js";

/**
 * The one error shape every endpoint returns: `{ error: { code, message, details? } }`.
 *
 * Two constraints, both from the security review:
 *
 * - The `code` set is closed. A client branches on the code, never on the message, and a new
 *   failure mode has to be added here rather than leaking a service's own wording.
 * - `details` never echoes request input. It is a small closed union of server-derived values —
 *   a version number, a retry delay, a domain rule token, a field path taken from the schema.
 *   Echoing the offending value back is how an error page becomes a reflection oracle, and
 *   `initData` is in the request too.
 */

export const API_ERROR_CODES = [
  /** The body, query or path failed the contract. `details` names the fields, never their values. */
  "validation_failed",
  /** No usable `initData`, or the user is not an active allowlisted member. One message for all three. */
  "unauthorized",
  /** Authenticated, but this action is not allowed for this user right now. */
  "forbidden",
  /** No such object in this workspace. A foreign id is a not-found, never a 403. */
  "not_found",
  /** An optimistic version did not match; the client refetches and re-renders. */
  "conflict",
  /** A `DomainRuleError`: a legal request the domain refuses. `details.rule` is its code. */
  "domain_rule",
  /** The AI or voice consent this action needs has not been granted. */
  "consent_required",
  /** The IP or per-user limiter refused. */
  "rate_limited",
  /** A dependency (database, Telegram) is unavailable; the request may succeed later. */
  "unavailable",
  /** Anything else. Never carries a message derived from the thrown error. */
  "internal",
] as const;

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** A field path taken from a zod issue, restricted to what a schema can legitimately produce. */
export const SafeFieldPathSchema = z.string().regex(/^[A-Za-z0-9_.[\]]{1,64}$/u);

/** A stable token, not a sentence: the `code` of a `DomainRuleError` or an equivalent identifier. */
export const SafeRuleTokenSchema = z.string().regex(/^[a-z0-9_]{1,64}$/u);

export const ErrorDetailsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fields"), fields: z.array(SafeFieldPathSchema).max(20) }).strict(),
  z.object({ kind: z.literal("conflict"), currentVersion: VersionSchema.nullable() }).strict(),
  z.object({ kind: z.literal("rule"), rule: SafeRuleTokenSchema }).strict(),
  z.object({ kind: z.literal("retry"), retryAfterSeconds: z.number().int().min(0).max(86_400) }).strict(),
  z.object({ kind: z.literal("consent"), scope: z.enum(["text", "voice"]) }).strict(),
]);

export const ApiErrorBodySchema = z
  .object({
    code: ApiErrorCodeSchema,
    /** A fixed sentence per code (see `API_ERROR_MESSAGES`); the client shows its own copy. */
    message: z.string().min(1).max(200),
    details: ErrorDetailsSchema.optional(),
  })
  .strict();

export const ErrorEnvelopeSchema = z.object({ error: ApiErrorBodySchema }).strict();

/**
 * HTTP status per code. `unauthorized` covers unknown, disabled and deletion-pending users with one
 * identical answer, so the API cannot be used to enumerate who has an account.
 */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  domain_rule: 422,
  consent_required: 428,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

/**
 * The fixed message per code. It is diagnostic text for a developer reading a network log; the
 * user-facing sentence comes from `web/src/i18n/`, which is why nothing here is translated.
 */
export const API_ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  validation_failed: "Request does not match the contract",
  unauthorized: "Authentication required",
  forbidden: "Not allowed",
  not_found: "Not found",
  conflict: "The object changed since it was read",
  domain_rule: "The change is not allowed by a domain rule",
  consent_required: "Consent required",
  rate_limited: "Too many requests",
  unavailable: "Temporarily unavailable",
  internal: "Internal error",
};

export type ErrorDetails = z.infer<typeof ErrorDetailsSchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
