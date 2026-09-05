import { HttpException } from "@nestjs/common";
import { API_ERROR_MESSAGES, API_ERROR_STATUS, type ApiErrorCode, type ErrorDetails, type ErrorEnvelope } from "../contracts/index.js";

/**
 * The only exception an API controller should throw.
 *
 * It carries a code from the closed set and, at most, server-derived `details`. Nothing constructed
 * here can echo request input back: `details` is a closed union of a version, a delay, a rule token,
 * a consent scope and a list of schema field paths, and the message comes from a fixed table.
 *
 * That matters more than it looks. The request body is next to `Authorization: tma <initData>` in
 * the same transaction, and an error that helpfully quotes what it received is the shortest path
 * from a bad request to a leaked signature in someone's proxy log.
 */
export class ApiError extends HttpException {
  constructor(
    readonly code: ApiErrorCode,
    readonly details?: ErrorDetails,
  ) {
    super(buildEnvelope(code, details), API_ERROR_STATUS[code]);
  }

  static unauthorized(): ApiError {
    return new ApiError("unauthorized");
  }

  static notFound(): ApiError {
    return new ApiError("not_found");
  }

  static forbidden(): ApiError {
    return new ApiError("forbidden");
  }

  /** A stale optimistic version. `currentVersion` is the row's own number, never the request's. */
  static conflict(currentVersion: number | null = null): ApiError {
    return new ApiError("conflict", { kind: "conflict", currentVersion });
  }

  /** A `DomainRuleError`. `rule` is its `code`, or a fallback token — never its message. */
  static domainRule(rule: string): ApiError {
    return new ApiError("domain_rule", { kind: "rule", rule: safeRuleToken(rule) });
  }

  static consentRequired(scope: "text" | "voice"): ApiError {
    return new ApiError("consent_required", { kind: "consent", scope });
  }

  static rateLimited(retryAfterSeconds: number): ApiError {
    return new ApiError("rate_limited", { kind: "retry", retryAfterSeconds: Math.max(0, Math.min(86_400, Math.ceil(retryAfterSeconds))) });
  }

  static validationFailed(fields: readonly string[]): ApiError {
    const safe = [...new Set(fields.map(safeFieldPath).filter((path): path is string => path !== null))].slice(0, 20);
    return new ApiError("validation_failed", { kind: "fields", fields: safe });
  }
}

export function buildEnvelope(code: ApiErrorCode, details?: ErrorDetails): ErrorEnvelope {
  return { error: { code, message: API_ERROR_MESSAGES[code], ...(details ? { details } : {}) } };
}

/**
 * A zod issue path is derived from the schema, but a `strict()` object reports an unrecognized key
 * by name and that name came from the request. Anything outside the identifier charset is dropped
 * rather than truncated, so no request-controlled text survives into the response.
 */
export function safeFieldPath(value: string): string | null {
  return /^[A-Za-z0-9_.[\]]{1,64}$/u.test(value) ? value : null;
}

function safeRuleToken(value: string): string {
  const token = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/gu, "_")
    .slice(0, 64);
  return /^[a-z0-9_]{1,64}$/u.test(token) ? token : "domain_rule";
}
