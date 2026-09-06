import type { Context } from "grammy";
import type { AccessService } from "../access/access.service.js";
import type { SettingsService } from "../settings/settings.service.js";
import type { TelegramLocale } from "./telegram-locale.js";

export type ActiveAccess = NonNullable<Awaited<ReturnType<AccessService["resolveActiveUser"]>>>;
export type UserSettingsRow = NonNullable<Awaited<ReturnType<SettingsService["get"]>>>;

/**
 * What the access middleware resolves once per update. Handlers read it instead of repeating
 * the allowlist lookup; a handler that runs at all is talking to an active, allowlisted user
 * except the few that opt out (`/start` with an invitation, `/restore`).
 */
export interface TelegramState {
  access: ActiveAccess | null;
  settings: UserSettingsRow | null;
  locale: TelegramLocale;
  /**
   * The Mini App origin when `WEBAPP_ENABLED` is on, `null` when it is off.
   *
   * It is configuration, not per-update state, but it is resolved here for the same reason the
   * access row is: every view that could carry a launch button would otherwise need `APP_CONFIG`
   * injected into the service that builds it. One value on the context, read through
   * `activeState`, keeps the keyboards pure functions of their arguments — and makes the flag-off
   * claim testable, because a context without it produces exactly today's keyboards.
   */
  webAppUrl: string | null;
}

export type AppContext = Context & { state: TelegramState };

/** Narrow `ctx.state` to an active user; handlers behind the access gate call this once. */
export function activeState(ctx: AppContext): { access: ActiveAccess; settings: UserSettingsRow; locale: TelegramLocale; webAppUrl: string | null } {
  const { access, settings, locale, webAppUrl } = ctx.state;
  if (!access || !settings) throw new Error("handler reached without active access; register it behind the access gate");
  return { access, settings, locale, webAppUrl: webAppUrl ?? null };
}
