import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AccessService } from "../../access/access.service.js";
import { APP_CONFIG, type AppConfig } from "../../config.js";
import { verifyInitData, type InitDataRejection } from "../../core/init-data.js";
import { logger } from "../../observability/logger.js";
import { SettingsService } from "../../settings/settings.service.js";
import { telegramLocale } from "../../telegram/telegram-locale.js";
import { ApiError } from "../http/api-error.js";
import { ApiIpRateLimiter, ApiUserRateLimiter } from "./rate-limiter.js";
import { setWebAuthContext, type WebAuthContext, type WebAuthenticatedRequest } from "./web-auth-context.js";

/**
 * The one place the Mini App decides who is calling.
 *
 * It is the bot's access middleware with a signature check in front: verify Telegram's HMAC over
 * `initData`, trade the Telegram id for the internal user through `AccessService.resolveActiveUser`
 * — the same call the bot makes — and attach `{ access, settings, locale }` so a controller reads
 * the caller exactly the way a handler reads `ctx.state`.
 *
 * The order is from design.md § 8 and is not a preference:
 *
 *   IP limiter → HMAC → resolveActiveUser → per-user limiter
 *
 * The database is behind the signature check. A stranger who cannot sign a payload cannot make this
 * process open a connection, and the only work they can cause is one HMAC, bounded by the IP
 * limiter. Moving `resolveActiveUser` earlier — to tell an unknown user apart from a bad signature,
 * say — would hand an unauthenticated caller a query per request.
 *
 * Every refusal is the same `unauthorized`: unknown, disabled, deletion-pending, expired, forged and
 * absent are one answer with one message, so the endpoint cannot be used to find out who has an
 * account. A deletion-pending user is refused here by design; `/restore` stays a chat command, and
 * the settings screen has to say so (tasks.md § 8.2).
 *
 * Nothing derived from the payload is ever logged. The failure reason is a fixed token from a closed
 * set and the identity is the internal uuid — `safeError` keeps 300 characters of a message and
 * knows nothing about `hash=` or `first_name`, so an interpolated `initData` would travel in full.
 */
@Injectable()
export class InitDataGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly ipLimiter: ApiIpRateLimiter,
    private readonly userLimiter: ApiUserRateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WebAuthenticatedRequest>();
    const requestId = randomUUID();

    // 1. The IP limiter, before anything else. `req.ip` is the client only because `main.ts` trusts
    //    exactly one proxy hop; with the default it would be Caddy's address for every request.
    const address = typeof request.ip === "string" && request.ip.length > 0 ? request.ip : "unknown";
    const byAddress = this.ipLimiter.consume(address);
    if (!byAddress.allowed) {
      logger.warn("web request refused", { requestId, reason: "rate_limited_ip" });
      throw ApiError.rateLimited(byAddress.retryAfterSeconds);
    }

    const raw = bearerInitData(request);
    if (raw === null) return this.refuse(requestId, "authorization_missing");

    // 2. The HMAC. Cheap, no database, and everything after it is talking to Telegram's word.
    const verified = verifyInitData(raw, this.config.telegramBotToken);
    if (!verified.ok) return this.refuse(requestId, verified.reason);

    // 3. The allowlist, resolved on every request — which is why disabling a user takes effect at
    //    once on both surfaces even though `initData` stays signed for 24 hours.
    const access = await this.access.resolveActiveUser(verified.data.user.id);
    if (!access) return this.refuse(requestId, "not_active");

    const settings = await this.settings.get(access.user.id);
    if (!settings) {
      // An active user without a settings row is a broken account, not a caller error. The bot says
      // so and stops; here it is a 503, because the request may well succeed once it is repaired.
      logger.error("active user without settings row", { requestId, userId: access.user.id });
      throw new ApiError("unavailable");
    }

    // 4. The per-user limiter, keyed on the internal uuid.
    const byUser = this.userLimiter.consume(access.user.id);
    if (!byUser.allowed) {
      logger.warn("web request refused", { requestId, userId: access.user.id, reason: "rate_limited_user" });
      throw ApiError.rateLimited(byUser.retryAfterSeconds);
    }

    const authContext: WebAuthContext = {
      requestId,
      access,
      settings,
      // The same resolution the bot middleware performs: a pinned language wins, then the language
      // Telegram reports in this payload, then the one last remembered, then English.
      locale: telegramLocale(settings.pinnedLanguage, verified.data.user.languageCode ?? settings.telegramLanguage ?? undefined),
      isOwner: this.config.ownerTelegramUserId !== undefined && this.config.ownerTelegramUserId === verified.data.user.id,
    };
    setWebAuthContext(request, authContext);
    return true;
  }

  /** One refusal, one log line, one fixed token. The caller learns only that it was refused. */
  private refuse(requestId: string, reason: InitDataRejection | "authorization_missing" | "not_active"): never {
    logger.warn("web request refused", { requestId, reason });
    throw ApiError.unauthorized();
  }
}

/**
 * `Authorization: tma <initDataRaw>`, the scheme the Telegram Mini App SDK documents.
 *
 * The header, not a query parameter and not a body field: a query string is written to every access
 * log and proxy on the path, and `initData` is a bearer credential for 24 hours.
 */
function bearerInitData(request: WebAuthenticatedRequest): string | null {
  const header = request.headers?.["authorization"];
  const value = typeof header === "string" ? header : Array.isArray(header) && typeof header[0] === "string" ? header[0] : null;
  if (!value) return null;
  const separator = value.indexOf(" ");
  if (separator === -1) return null;
  if (value.slice(0, separator).toLowerCase() !== "tma") return null;
  const raw = value.slice(separator + 1).trim();
  return raw.length > 0 ? raw : null;
}
