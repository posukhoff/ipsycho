import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { AppConfig } from "../config.js";
import { AiTurnSchema } from "./ai-contracts.js";
import type { AiProvider, AiProviderResult, AiRequest } from "./ai-provider.js";

const STRUCTURED_REPAIR = "Previous structured output was invalid or empty. Return exactly one object matching the requested schema.";

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  private readonly client: OpenAI | null;

  constructor(config: AppConfig) {
    this.client = config.openAiApiKey ? new OpenAI({ apiKey: config.openAiApiKey, maxRetries: 0 }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async generate(request: AiRequest): Promise<AiProviderResult> {
    if (!this.client) throw new Error("OpenAI is not configured");
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.client.responses.parse({
        model: request.model,
        input: [
          { role: "system", content: attempt ? `${request.systemPrompt}\n\n${STRUCTURED_REPAIR}` : request.systemPrompt },
          ...request.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
        text: { format: zodTextFormat(AiTurnSchema, "ipsycho_turn") },
      });
      const usage = response.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      inputTokens += usage?.input_tokens ?? 0;
      outputTokens += usage?.output_tokens ?? 0;
      const turn = response.output_parsed;
      if (!turn) continue;
      return {
        turn,
        ...(response.id ? { requestId: response.id } : {}),
        ...(inputTokens ? { inputTokens } : {}),
        ...(outputTokens ? { outputTokens } : {}),
      };
    }
    throw new Error("OpenAI returned no valid structured output after one repair attempt");
  }
}
