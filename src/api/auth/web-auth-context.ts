import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AccessService } from "../../access/access.service.js";
import type { SettingsService } from "../../settings/settings.service.js";
import type { TelegramLocale } from "../../telegram/telegram-locale.js";
import { ApiError } from "../http/api-error.js";

/**
 * What `InitDataGuard` resolves once per request, and the only thing a controller may read about
 * who is calling.
 *
 * It is the bot's `ctx.state` — `{ access, settings, locale }` — with two additions the web needs
 * and the bot gets for free: a request id for the log, and the owner flag the invite command
 * derives from the Telegram id, computed here so the id itself never travels any further.
 *
 * The types are derived from the services rather than restated, exactly as `telegram-context.ts`
 * does it, so a column added to `user_settings` shows up on both surfaces at once.
 */
export type WebAccess = NonNullable<Awaited<ReturnType<AccessService["resolveActiveUser"]>>>;
export type WebSettingsRow = NonNullable<Awaited<ReturnType<SettingsService["get"]>>>;

export interface WebAuthContext {
  /** Random per request, logged with every line the request produces. Never leaves the process. */
  requestId: string;
  access: WebAccess;
  settings: WebSettingsRow;
  locale: TelegramLocale;
  /** True only for `OWNER_TELEGRAM_USER_ID`; the same rule `/invite` applies. */
  isOwner: boolean;
}

/** The property the guard writes on the Express request. */
export const WEB_AUTH_CONTEXT_KEY = "webAuth";

export type WebAuthenticatedRequest = { [WEB_AUTH_CONTEXT_KEY]?: WebAuthContext; ip?: string; headers?: Record<string, unknown> };

export function setWebAuthContext(request: WebAuthenticatedRequest, context: WebAuthContext): void {
  request[WEB_AUTH_CONTEXT_KEY] = context;
}

/**
 * Reads what the guard resolved.
 *
 * It throws `unauthorized` rather than returning `undefined`, because the only way to reach it
 * without a context is a controller that forgot `@UseGuards(InitDataGuard)` — and the safe failure
 * for that mistake is a refusal, not an unauthenticated read.
 */
export function webAuthOf(request: unknown): WebAuthContext {
  const context = (request as WebAuthenticatedRequest | null)?.[WEB_AUTH_CONTEXT_KEY];
  if (!context) throw ApiError.unauthorized();
  return context;
}

/** The fields every log line inside an authenticated request carries. Internal uuid only. */
export function webLogContext(context: WebAuthContext): { requestId: string; userId: string } {
  return { requestId: context.requestId, userId: context.access.user.id };
}

/** `me(@CurrentUser() user: WebAuthContext)`. Groups 2–4 read the caller through this. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): WebAuthContext => webAuthOf(context.switchToHttp().getRequest<unknown>()));
