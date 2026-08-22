import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { AppConfig } from "../config.js";
import { AiTurnSchema } from "./ai-contracts.js";
import type { AiProvider, AiProviderResult, AiRequest } from "./ai-provider.js";

const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const STRUCTURED_REPAIR = "Previous structured output was invalid or empty. Return exactly one object matching the requested schema.";

export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  private readonly client: OpenAI | null;

  constructor(config: AppConfig) {
    this.client = config.geminiApiKey
      ? new OpenAI({ apiKey: config.geminiApiKey, baseURL: GEMINI_OPENAI_BASE_URL, maxRetries: 0 })
      : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async generate(request: AiRequest): Promise<AiProviderResult> {
    if (!this.client) throw new Error("Gemini is not configured");
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.client.chat.completions.parse({
        model: request.model,
        messages: [
          { role: "system", content: attempt ? `${request.systemPrompt}\n\n${STRUCTURED_REPAIR}` : request.systemPrompt },
          ...request.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
        response_format: zodResponseFormat(AiTurnSchema, "ipsycho_turn"),
      });
      inputTokens += response.usage?.prompt_tokens ?? 0;
      outputTokens += response.usage?.completion_tokens ?? 0;
      const turn = response.choices[0]?.message.parsed;
      if (!turn) continue;
      return {
        turn,
        ...(response.id ? { requestId: response.id } : {}),
        ...(inputTokens ? { inputTokens } : {}),
        ...(outputTokens ? { outputTokens } : {}),
      };
    }
    throw new Error("Gemini returned no valid structured output after one repair attempt");
  }
}
