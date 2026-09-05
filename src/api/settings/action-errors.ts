import { ActionStateUncertainError } from "../../actions/actions.service.js";
import type { ActionIssue } from "../../core/ai-actions.js";
import { isDomainRuleError } from "../../core/errors.js";
import { ApiError } from "../http/api-error.js";

/**
 * How a journaled write's refusal becomes one of the ten error codes.
 *
 * Every write in this group goes through `ActionsService`, so it fails in exactly two ways: as a
 * list of `ActionIssue` from `validateResolved`, or as a throw from `applyResolved`. Both are
 * translated here rather than in each controller, because the interesting distinction — a stale
 * optimistic version is a `conflict` the client can recover from, everything else is a
 * `domain_rule` it can only report — is easy to get wrong once per endpoint.
 *
 * Nothing derived from a message reaches the client. `ApiError.domainRule` keeps the code token and
 * `ApiError.conflict` carries the row's own version, never the one the request sent.
 */
const STALE_CODES = new Set(["stale", "settings_stale", "memory_stale"]);

/**
 * The domain's own stale refusals are `DomainRuleError`s with no code — `settings are stale or
 * missing`, `memory is stale or missing`, `memory changed before deletion`. They are raised inside
 * the transaction, after validation passed, when another writer moved the row in between. A 422
 * would tell the client the change is impossible; it is a 409 and a refetch fixes it.
 */
const STALE_MESSAGE = /\b(?:stale|missing|changed)\b/iu;

export function apiErrorForIssues(issues: readonly ActionIssue[], currentVersion: number | null): ApiError {
  const issue = issues[0];
  if (!issue) return new ApiError("internal");
  if (issue.kind === "reference" || STALE_CODES.has(issue.code)) return ApiError.conflict(currentVersion);
  return ApiError.domainRule(issue.code);
}

/** Re-throws whatever `applyResolved` threw as the API's own vocabulary. Never returns. */
export function rethrowWriteError(error: unknown, currentVersion: number | null): never {
  if (error instanceof ApiError) throw error;
  // The connection broke mid-transaction: the commit may or may not have landed, so the honest
  // answer is «try again later», never a success and never a retry the client repeats blindly.
  if (error instanceof ActionStateUncertainError) throw new ApiError("unavailable");
  if (isDomainRuleError(error)) {
    if (!error.code && STALE_MESSAGE.test(error.message)) throw ApiError.conflict(currentVersion);
    throw ApiError.domainRule(error.code ?? "domain_rule");
  }
  throw error;
}
