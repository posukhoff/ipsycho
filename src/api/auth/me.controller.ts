import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { AiService } from "../../ai/ai.service.js";
import { ChatService } from "../../chat/chat.service.js";
import { APP_CONFIG, type AppConfig } from "../../config.js";
import { localDateAt } from "../../core/timezone.js";
import { MeResponseSchema, type ConsentState, type MeResponse } from "../contracts/index.js";
import { apiRoute } from "../http/routes.js";
import { InitDataGuard } from "./init-data.guard.js";
import { presentSettings } from "./settings.presenter.js";
import { CurrentUser, type WebAuthContext } from "./web-auth-context.js";

/**
 * `GET /api/v1/me` — the one call the shell makes before it renders anything.
 *
 * Everything a screen needs to decide what to show and in which language: who the request resolved
 * to, the settings, the local day in the user's timezone, and whether the AI and its consents are
 * usable. One call rather than four, because a Mini App is opened cold every time and each round
 * trip is visible as a blank screen.
 *
 * There is no Telegram identity in the answer. The guard trades `user.id` for the internal uuid and
 * drops the rest, so a leaked response body is not a leak of the allowlist.
 */
@Controller(apiRoute())
@UseGuards(InitDataGuard)
export class MeController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly ai: AiService,
    private readonly chat: ChatService,
  ) {}

  @Get("me")
  async me(@CurrentUser() user: WebAuthContext): Promise<MeResponse> {
    const { access, settings, locale } = user;
    const [historyMessageCount, consents, callsLastHour] = await Promise.all([
      this.chat.historyMessageCount(access.workspaceId, access.user.id),
      this.consentStates(access.user.id),
      this.ai.callsLastHour(access.user.id),
    ]);

    // Parsed against the contract before it leaves: a presenter that drifts is a server fault, and
    // group 0's filter turns the ZodError into an `internal` with the field paths in the log.
    return MeResponseSchema.parse({
      access: { userId: access.user.id, workspaceId: access.workspaceId, status: "active", isOwner: user.isOwner },
      locale,
      timezone: settings.timezone,
      todayLocalDate: localDateAt(new Date(), settings.timezone),
      ai: {
        status: access.user.aiStatus,
        configured: this.chat.isAiConfigured(),
        provider: this.chat.providerName,
        // The hourly call budget, so the screen can say «подожди» instead of failing a turn. The
        // message budget is the other half of `aiBurstAllowed` and needs the messages repository,
        // which `src/api/**` may not touch; `ChatService` re-checks both at the boundary anyway.
        rateLimited: callsLastHour >= this.ai.maxCallsPerHour,
      },
      consents,
      settings: presentSettings(settings, { historyMessageCount }),
      commit: this.config.appCommit ?? null,
    } satisfies MeResponse);
  }

  /**
   * Two scopes, two providers. `text` is the configured chat provider; `voice` is always OpenAI,
   * because transcription runs there whichever provider answers the chat — which is exactly why the
   * two are asked for separately in the bot, and why the screen has to show them separately too.
   */
  private async consentStates(userId: string): Promise<ConsentState[]> {
    const version = this.ai.consentVersion;
    const [text, voice] = await Promise.all([this.ai.hasConsent(userId), this.ai.hasProviderConsent(userId, "openai")]);
    return [
      { scope: "text", granted: text, provider: this.ai.providerName, version },
      { scope: "voice", granted: voice, provider: "openai", version },
    ];
  }
}
