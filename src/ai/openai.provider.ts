import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { ZodError } from "zod";
import type { AppConfig } from "../config.js";
import { createOpenAiCompatibleClient } from "./ai-client.js";
import { AiTurnSchema } from "./ai-contracts.js";
import { AiStructuredOutputError, describeStructuredIssues, structuredRepairSuffix, type AiProvider, type AiProviderResult, type AiRequest } from "./ai-provider.js";

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
    if (!this.client) throw new Error("OpenAI is not configured");
    let inputTokens = 0;
    let outputTokens = 0;
    let issues: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response;
      try {
        // Transport/API errors propagate: durable retry policy lives in MessagesRepository.
        response = await this.client.responses.parse({
          model: request.model,
          input: [
            { role: "system", content: attempt ? `${request.systemPrompt}\n\n${structuredRepairSuffix(issues)}` : request.systemPrompt },
            ...request.messages.map((message) => ({ role: message.role, content: message.content })),
          ],
          text: { format: zodTextFormat(AiTurnSchema, "ipsycho_turn") },
        });
      } catch (error) {
        if (!isStructuredOutputValidationError(error)) throw error;
        issues = describeStructuredIssues(error);
        continue;
      }
      const usage = response.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      inputTokens += usage?.input_tokens ?? 0;
      outputTokens += usage?.output_tokens ?? 0;
      const turn = response.output_parsed;
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
    throw new AiStructuredOutputError("OpenAI returned no valid structured output after one repair attempt");
  }
}

export function isStructuredOutputValidationError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}
