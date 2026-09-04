import type OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { AppConfig } from "../config.js";
import { createOpenAiCompatibleClient } from "./ai-client.js";
import { AiTurnWireSchema } from "./ai-contracts.js";
import { structuredTurn, type AiProvider, type AiProviderResult, type AiRequest } from "./ai-provider.js";

const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  private readonly client: OpenAI | null;

  constructor(config: AppConfig) {
    this.client = config.geminiApiKey ? createOpenAiCompatibleClient({ apiKey: config.geminiApiKey, baseURL: GEMINI_OPENAI_BASE_URL }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async generate(request: AiRequest): Promise<AiProviderResult> {
    const client = this.client;
    if (!client) throw new Error("Gemini is not configured");
    return structuredTurn(this.name, async (repairSuffix) => {
      const response = await client.chat.completions.create({
        model: request.model,
        messages: [
          { role: "system", content: repairSuffix ? `${request.systemPrompt}\n\n${repairSuffix}` : request.systemPrompt },
          ...request.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
        response_format: zodResponseFormat(AiTurnWireSchema, "ipsycho_turn"),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { max_completion_tokens: request.maxOutputTokens } : {}),
      });
      const message = response.choices[0]?.message;
      return {
        text: message?.content ?? null,
        refusal: message?.refusal ?? null,
        requestId: response.id,
        usage: {
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
          cachedInputTokens: response.usage?.prompt_tokens_details?.cached_tokens,
        },
      };
    });
  }
}
