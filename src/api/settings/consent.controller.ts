import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { AiService } from "../../ai/ai.service.js";
import { ChatService } from "../../chat/chat.service.js";
import { ConsentRequestSchema, ConsentResponseSchema, type ConsentRequest, type ConsentResponse, type ConsentState } from "../contracts/index.js";
import { apiRoute } from "../http/routes.js";
import { zodBody } from "../http/zod-validation.pipe.js";
import { CurrentUser, InitDataGuard, type WebAuthContext } from "../auth/index.js";

/**
 * Provider consent, as the settings screen shows and changes it.
 *
 * This is a **pre-check**, not the gate. `ChatService` re-reads consent immediately before it calls
 * the model and `TranscriptionService` does the same before it uploads audio; those checks stay
 * authoritative, and nothing here may be read as permission by anything downstream. What this
 * endpoint buys is a screen that can say «AI is off because you have not agreed» instead of a turn
 * that fails in the chat a minute later.
 *
 * Two scopes because there are two providers. `text` is whichever provider is configured; `voice`
 * is always OpenAI, since transcription runs there whoever answers the chat — which is exactly why
 * the bot asks for the two separately (`ai:consent` and `voice:consent`).
 */
@Controller(apiRoute("consent"))
@UseGuards(InitDataGuard)
export class WebConsentController {
  constructor(
    private readonly ai: AiService,
    private readonly chat: ChatService,
  ) {}

  @Get()
  consents(@CurrentUser() user: WebAuthContext): Promise<ConsentResponse> {
    return this.present(user.access.user.id);
  }

  @Post("grant")
  async grant(@CurrentUser() user: WebAuthContext, @Body(zodBody(ConsentRequestSchema)) body: ConsentRequest): Promise<ConsentResponse> {
    const userId = user.access.user.id;
    // Granting voice grants both providers, because a voice turn is a transcription *and* a model
    // turn: `ChatService.voiceGate` requires both, and granting one of them would leave a screen
    // that says yes and a bot that still refuses.
    if (body.scope === "voice") await this.chat.grantVoiceConsent(userId);
    else await this.chat.grantConsent(userId);
    return this.present(userId);
  }

  @Post("revoke")
  async revoke(@CurrentUser() user: WebAuthContext, @Body(zodBody(ConsentRequestSchema)) body: ConsentRequest): Promise<ConsentResponse> {
    const userId = user.access.user.id;
    // Revoking text revokes both — what `/ai_revoke` does — because voice cannot outlive it.
    // Revoking voice touches OpenAI alone, and when OpenAI *is* the chat provider that is one row
    // and the answer below says so rather than pretending text survived.
    if (body.scope === "voice") await this.ai.revokeProviderConsent(userId, "openai");
    else await this.chat.revokeConsent(userId);
    return this.present(userId);
  }

  private async present(userId: string): Promise<ConsentResponse> {
    const version = this.ai.consentVersion;
    const [text, voice] = await Promise.all([this.ai.hasConsent(userId), this.ai.hasProviderConsent(userId, "openai")]);
    const consents: ConsentState[] = [
      { scope: "text", granted: text, provider: this.ai.providerName, version },
      { scope: "voice", granted: voice, provider: "openai", version },
    ];
    return ConsentResponseSchema.parse({ consents } satisfies ConsentResponse);
  }
}
