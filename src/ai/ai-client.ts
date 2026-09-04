import OpenAI from "openai";

/**
 * Every provider call runs inside a Telegram turn. The SDK default of 600 s would let one stalled
 * connection hold a user's turn (and, before per-chat concurrency, the whole bot) for ten minutes;
 * the durable retry ladder in core/ai-retry-policy.ts already covers the failure.
 */
export const AI_REQUEST_TIMEOUT_MS = 45_000;
export const VOICE_DOWNLOAD_TIMEOUT_MS = 20_000;

export function createOpenAiCompatibleClient(input: { apiKey: string; baseURL?: string }): OpenAI {
  return new OpenAI({
    apiKey: input.apiKey,
    ...(input.baseURL ? { baseURL: input.baseURL } : {}),
    maxRetries: 0,
    timeout: AI_REQUEST_TIMEOUT_MS,
  });
}
