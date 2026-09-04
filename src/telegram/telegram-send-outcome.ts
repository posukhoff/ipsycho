import { GrammyError, HttpError } from "grammy";

/**
 * What a failed Telegram send means for a durable delivery.
 *
 * - `rate_limited`: Telegram answered 429; retry after the given delay without spending an attempt.
 * - `rejected`: Telegram answered with a client error that will not change (blocked bot, unknown chat).
 * - `transient`: the request never reached Telegram (connection refused, DNS); retrying is safe.
 * - `ambiguous`: the request may have reached Telegram (timeout, reset mid-response); a retry may
 *   duplicate the message, so the delivery is recorded as ambiguous and never resent automatically.
 * - `unknown`: anything else, treated like transient by callers that retry with a bounded attempt count.
 */
export type TelegramSendOutcome =
  { kind: "rate_limited"; retryAfterSeconds: number } | { kind: "rejected"; errorCode: number } | { kind: "transient" } | { kind: "ambiguous" } | { kind: "unknown" };

const NOTHING_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

export function classifyTelegramSendError(error: unknown): TelegramSendOutcome {
  if (error instanceof GrammyError) {
    if (error.error_code === 429) {
      const retryAfter = error.parameters.retry_after;
      return { kind: "rate_limited", retryAfterSeconds: typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : 5 };
    }
    if (error.error_code >= 400 && error.error_code < 500) return { kind: "rejected", errorCode: error.error_code };
    return { kind: "transient" };
  }
  if (error instanceof HttpError) {
    return NOTHING_SENT_CODES.has(networkErrorCode(error.error)) ? { kind: "transient" } : { kind: "ambiguous" };
  }
  return { kind: "unknown" };
}

function networkErrorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}
