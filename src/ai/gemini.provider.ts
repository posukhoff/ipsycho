import type OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { AppConfig } from "../config.js";
import { createOpenAiCompatibleClient } from "./ai-client.js";
import { AiTurnSchema } from "./ai-contracts.js";
import { AiStructuredOutputError, describeStructuredIssues, structuredRepairSuffix, type AiProvider, type AiProviderResult, type AiRequest } from "./ai-provider.js";
import { isStructuredOutputValidationError } from "./openai.provider.js";

const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  private readonly client: OpenAI | null;

  constructor(config: AppConfig) {
    this.client = config.geminiApiKey
      ? createOpenAiCompatibleClient({ apiKey: config.geminiApiKey, baseURL: GEMINI_OPENAI_BASE_URL })
      : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async generate(request: AiRequest): Promise<AiProviderResult> {
    if (!this.client) throw new Error("Gemini is not configured");
    let inputTokens = 0;
    let outputTokens = 0;
    let issues: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response;
      try {
        // Transport/API errors propagate: durable retry policy lives in MessagesRepository.
        response = await this.client.chat.completions.parse({
          model: request.model,
          messages: [
            { role: "system", content: attempt ? `${request.systemPrompt}\n\n${structuredRepairSuffix(issues)}` : request.systemPrompt },
            ...request.messages.map((message) => ({ role: message.role, content: message.content })),
          ],
          response_format: zodResponseFormat(AiTurnSchema, "ipsycho_turn"),
        });
      } catch (error) {
        if (!isStructuredOutputValidationError(error)) throw error;
        issues = describeStructuredIssues(error);
        continue;
      }
      inputTokens += response.usage?.prompt_tokens ?? 0;
      outputTokens += response.usage?.completion_tokens ?? 0;
      const turn = response.choices[0]?.message.parsed;
      if (!turn) {
        issues = [];
        continue;
      }
      return {
        turn,
        ...(response.id ? { requestId: response.id } : {}),
        ...(inputTokens ? { inputTokens } : {}),
        ...(outputTokens ? { outputTokens } : {}),
      };
    }
    throw new AiStructuredOutputError("Gemini returned no valid structured output after one repair attempt");
  }
}
