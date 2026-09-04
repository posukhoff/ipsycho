import type { ZodError } from "zod";
import { AiTurnWireSchema, flattenTurn, type AiTurn } from "./ai-contracts.js";
import { logger } from "../observability/logger.js";

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiRequest {
  model: string;
  systemPrompt: string;
  messages: AiMessage[];
  /** Omitted when the model only accepts its default (reasoning models reject other values). */
  temperature?: number;
  maxOutputTokens?: number;
}

export interface AiProviderResult {
  turn: AiTurn;
  requestId?: string;
  /** Summed over every HTTP request of this call, including a failed first attempt. */
  inputTokens?: number;
  outputTokens?: number;
  /** Part of `inputTokens` served from the provider's prompt cache, when reported. */
  cachedInputTokens?: number;
  /** HTTP requests made for this one call: 1, or 2 when the structured output needed one repair. */
  attempts: number;
}

export interface AiProvider {
  readonly name: string;
  isConfigured(): boolean;
  generate(request: AiRequest): Promise<AiProviderResult>;
}

export const AI_PROVIDER = Symbol("AI_PROVIDER");

/**
 * The provider produced no turn matching the contract after its one repair attempt.
 * Carries only a message: the raw output stays with the provider and never reaches logs
 * or the chat pipeline, which answers with a deterministic "did not understand" reply.
 */
export class AiStructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiStructuredOutputError";
  }
}

/** Zod issues reduced to paths and codes: enough to repair the shape, never the values. */
export function describeStructuredIssues(error: Pick<ZodError, "issues"> | null | undefined): string[] {
  if (!error?.issues?.length) return [];
  return error.issues.slice(0, 20).map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.code}`);
}

/** Appended to the system prompt on the second structured attempt. */
export function structuredRepairSuffix(issues: readonly string[]): string {
  const base = "Previous structured output was invalid or empty. Return exactly one object matching the requested schema.";
  return issues.length ? `${base} Schema issues (path: code): ${issues.join("; ")}.` : base;
}

export const STRUCTURED_ATTEMPTS = 2;

export interface StructuredAttempt {
  /** The model's text, or null when it produced none (or a refusal, reported separately). */
  text: string | null;
  refusal?: string | null;
  requestId?: string | null;
  usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined; cachedInputTokens?: number | undefined };
}

/**
 * One structured call with at most one repair. Every attempt's tokens are counted, including
 * the one whose output failed validation: that is exactly the request that costs the most.
 */
export async function structuredTurn(providerName: string, attempt: (repairSuffix: string | null) => Promise<StructuredAttempt>): Promise<AiProviderResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let issues: string[] = [];
  let attempts = 0;
  for (let index = 0; index < STRUCTURED_ATTEMPTS; index += 1) {
    attempts += 1;
    // Transport/API errors propagate: the durable retry policy lives in MessagesRepository.
    const response = await attempt(index ? structuredRepairSuffix(issues) : null);
    inputTokens += response.usage?.inputTokens ?? 0;
    outputTokens += response.usage?.outputTokens ?? 0;
    cachedInputTokens += response.usage?.cachedInputTokens ?? 0;
    if (response.refusal) {
      logger.warn("AI provider refused the request", { provider: providerName, attempt: attempts });
      issues = ["(root): refusal"];
      continue;
    }
    const text = response.text?.trim();
    if (!text) {
      issues = ["(root): empty"];
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      issues = ["(root): invalid_json"];
      continue;
    }
    const parsed = AiTurnWireSchema.safeParse(json);
    if (!parsed.success) {
      issues = describeStructuredIssues(parsed.error);
      continue;
    }
    return {
      turn: flattenTurn(parsed.data),
      attempts,
      ...(response.requestId ? { requestId: response.requestId } : {}),
      ...(inputTokens ? { inputTokens } : {}),
      ...(outputTokens ? { outputTokens } : {}),
      ...(cachedInputTokens ? { cachedInputTokens } : {}),
    };
  }
  throw new AiStructuredOutputError(`${providerName} returned no valid structured output after one repair attempt`);
}
