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
