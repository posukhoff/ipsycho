import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { ZodError } from "zod";
import type { AppConfig } from "../config.js";
import { createOpenAiCompatibleClient } from "./ai-client.js";
import { AiTurnSchema } from "./ai-contracts.js";
import { structuredTurn, type AiProvider, type AiProviderResult, type AiRequest } from "./ai-provider.js";

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  private readonly client: OpenAI | null;

  constructor(config: AppConfig) {
    this.client = config.openAiApiKey ? createOpenAiCompatibleClient({ apiKey: config.openAiApiKey }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async generate(request: AiRequest): Promise<AiProviderResult> {
    const client = this.client;
    if (!client) throw new Error("OpenAI is not configured");
    return structuredTurn(this.name, async (repairSuffix) => {
      const response = await client.responses.create({
        model: request.model,
        input: [
          { role: "system", content: repairSuffix ? `${request.systemPrompt}\n\n${repairSuffix}` : request.systemPrompt },
          ...request.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
        text: { format: zodTextFormat(AiTurnSchema, "ipsycho_turn") },
        // Conversation content is not retained on the provider side: consent covers processing, not storage.
        store: false,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { max_output_tokens: request.maxOutputTokens } : {}),
      });
      const refusal = response.output.flatMap((item) => (item.type === "message" ? item.content : [])).find((part) => part.type === "refusal");
      return {
        text: response.output_text || null,
        refusal: refusal?.type === "refusal" ? refusal.refusal : null,
        requestId: response.id,
        usage: {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens,
        },
      };
    });
  }
}

export function isStructuredOutputValidationError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}
