import { Inject, Injectable } from "@nestjs/common";
import type OpenAI from "openai";
import { toFile } from "openai";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { estimateAudioCostUsd } from "../core/ai-usage-policy.js";
import { voiceWithinLimits } from "../core/voice-policy.js";
import { createOpenAiCompatibleClient } from "./ai-client.js";
import { AiRepository } from "./ai.repository.js";

@Injectable()
export class TranscriptionService {
  private readonly client: OpenAI | null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repository: AiRepository,
  ) {
    this.client = config.aiProvider === "openai" && config.openAiApiKey ? createOpenAiCompatibleClient({ apiKey: config.openAiApiKey }) : null;
  }

  isAvailable(): boolean {
    return this.client !== null;
  }
  acceptsVoice(durationSeconds: number, bytes: number): boolean {
    return voiceWithinLimits({
      durationSeconds,
      bytes,
      maxDurationSeconds: this.config.aiVoiceMaxDurationSeconds,
      maxBytes: this.config.aiVoiceMaxBytes,
    });
  }

  async transcribe(input: { workspaceId: string; userId: string; audio: Buffer; durationSeconds: number; language?: string }): Promise<string> {
    if (!this.client) throw new Error("voice transcription is unavailable for the active provider");
    // Consent is re-checked at the external-provider boundary, not only before Telegram download.
    if (!(await this.repository.hasConsent(input.userId, "openai", this.config.aiConsentVersion))) throw new Error("voice transcription consent is missing");
    const started = Date.now();
    const model = this.config.aiTranscriptionModel;
    try {
      const file = await toFile(input.audio, "voice.ogg", { type: "audio/ogg" });
      const response = await this.client.audio.transcriptions.create({ model, file, ...(input.language ? { language: input.language } : {}) });
      const pricing = this.config.aiPricing[model];
      const estimatedCostUsd = estimateAudioCostUsd(input.durationSeconds, pricing);
      await this.repository.recordUsage({
        workspaceId: input.workspaceId,
        userId: input.userId,
        provider: "openai",
        model,
        latencyMs: Date.now() - started,
        status: "transcription_success",
        ...(pricing ? { pricingRevision: pricing.revision } : {}),
        ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
      });
      return response.text.trim();
    } catch (error) {
      await this.repository
        .recordUsage({ workspaceId: input.workspaceId, userId: input.userId, provider: "openai", model, latencyMs: Date.now() - started, status: "transcription_error" })
        .catch(() => undefined);
      throw error;
    }
  }
}
