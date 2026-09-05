import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { AiService } from "../../ai/ai.service.js";
import { ChatService } from "../../chat/chat.service.js";
import { ConsentRequestSchema, ConsentResponseSchema, type ConsentRequest, type ConsentResponse } from "../contracts/index.js";
import { apiRoute, zodBody } from "../http/index.js";
import { CurrentUser, InitDataGuard, presentConsents, type WebAuthContext } from "../auth/index.js";

/**
 * Provider consent, as the settings screen shows and changes it.
 *
 * This is a **pre-check**, not the gate. `ChatService` re-reads consent immediately before it calls
 * the model and `TranscriptionService` does the same before it uploads audio; those checks stay
 * authoritative, and nothing here may be read as permission by anything downstream. What this
 * endpoint buys is a screen that can say «AI is off because you have not agreed» instead of a turn
 * that fails in the chat a minute later.
 *
 * The two scopes and why they are two are `presentConsents`, which `GET /me` embeds as well: one
 * mapping, so the bootstrap and this endpoint cannot disagree about what the user agreed to.
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
  @HttpCode(200)
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
  @HttpCode(200)
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
    return ConsentResponseSchema.parse({ consents: await presentConsents(this.ai, userId) } satisfies ConsentResponse);
  }
}
