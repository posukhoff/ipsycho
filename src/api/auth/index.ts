/**
 * What groups 2–4 import from group 1. Nothing else in this directory is public.
 *
 * The guard and the two limiters come from `WebAuthModule` (import the module, then name the guard
 * in `@UseGuards`); `CurrentUser`, `WebAuthContext` and the two presenters are ordinary imports.
 */
export { WebAuthModule } from "./web-auth.module.js";
export { InitDataGuard } from "./init-data.guard.js";
export { ApiIpRateLimiter, ApiUserRateLimiter } from "./rate-limiter.js";
export { CurrentUser, type WebAuthContext, type WebSettingsRow } from "./web-auth-context.js";
export { presentConsents, presentSettings } from "./settings.presenter.js";
