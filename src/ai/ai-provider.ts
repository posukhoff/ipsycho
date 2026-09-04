import type { ZodError } from "zod";
import type { AiTurn } from "./ai-contracts.js";

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiRequest {
  model: string;
  systemPrompt: string;
  messages: AiMessage[];
}

export interface AiProviderResult {
  turn: AiTurn;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
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
