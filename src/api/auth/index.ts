/**
 * What groups 2–4 import from group 1. Nothing else in this directory is public.
 *
 * The guard and the two limiters come from `WebAuthModule` (import the module, then name the guard
 * in `@UseGuards`); `CurrentUser`, `WebAuthContext` and `presentSettings` are ordinary imports.
 */
export { WebAuthModule } from "./web-auth.module.js";
export { InitDataGuard } from "./init-data.guard.js";
export { ApiIpRateLimiter, ApiUserRateLimiter, SlidingWindowRateLimiter, IP_RATE_LIMIT, USER_RATE_LIMIT, type RateLimitDecision, type RateLimitOptions } from "./rate-limiter.js";
export { CurrentUser, webAuthOf, webLogContext, WEB_AUTH_CONTEXT_KEY, type WebAuthContext, type WebAccess, type WebSettingsRow } from "./web-auth-context.js";
export { presentSettings } from "./settings.presenter.js";
