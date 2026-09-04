import type OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { createOpenAiCompatibleClient } from "./ai-client.js";
import { AiTurnWireSchema } from "./ai-contracts.js";
import { structuredTurn, type AiProvider, type AiProviderResult, type AiRequest } from "./ai-provider.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
/**
 * DeepSeek has no schema-enforced output: the contract travels as a JSON Schema generated from
 * the Zod contract itself, so it can never drift from what the server validates. It is sent as
 * the first system message, ahead of the per-turn prompt, so the provider's prefix cache covers it.
 */
export const DEEPSEEK_JSON_INSTRUCTION = [
  "Return only one JSON object that is valid against the JSON Schema below. No markdown, no prose outside the JSON. Every listed property must be present; use null where a nullable property does not apply.",
  'Entities are referenced by the short ids from CURRENT_CONTEXT as {"id":"t1"} (tasks t*, goals g*, memory m*, a task created earlier in the same message n*). intent is "explicit" when the user asked for exactly this action or accepted your proposal, "inferred" when you propose it yourself.',
  JSON.stringify(z.toJSONSchema(AiTurnWireSchema)),
].join("\n");

export class DeepSeekProvider implements AiProvider {
  readonly name = "deepseek";
  private readonly client: OpenAI | null;

  constructor(config: AppConfig) {
    this.client = config.deepSeekApiKey ? createOpenAiCompatibleClient({ apiKey: config.deepSeekApiKey, baseURL: DEEPSEEK_BASE_URL }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async generate(request: AiRequest): Promise<AiProviderResult> {
    const client = this.client;
    if (!client) throw new Error("DeepSeek is not configured");
    return structuredTurn(this.name, async (repairSuffix) => {
      const response = await client.chat.completions.create({
        model: request.model,
        messages: [
          { role: "system", content: DEEPSEEK_JSON_INSTRUCTION },
          { role: "system", content: repairSuffix ? `${request.systemPrompt}\n\n${repairSuffix}` : request.systemPrompt },
          ...request.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
        response_format: { type: "json_object" },
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
      });
      const usage = response.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } | undefined;
      return {
        text: response.choices[0]?.message.content ?? null,
        requestId: response.id,
        usage: { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens, cachedInputTokens: usage?.prompt_cache_hit_tokens },
      };
    });
  }
}
