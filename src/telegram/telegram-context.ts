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
}

export type AppContext = Context & { state: TelegramState };

/** Narrow `ctx.state` to an active user; handlers behind the access gate call this once. */
export function activeState(ctx: AppContext): { access: ActiveAccess; settings: UserSettingsRow; locale: TelegramLocale } {
  const { access, settings, locale } = ctx.state;
  if (!access || !settings) throw new Error("handler reached without active access; register it behind the access gate");
  return { access, settings, locale };
}
