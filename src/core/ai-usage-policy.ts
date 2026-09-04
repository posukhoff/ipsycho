export interface AiPricing {
  inputUsdPerMillion?: number | undefined;
  outputUsdPerMillion?: number | undefined;
  /** Price of a prompt token served from the provider's cache; full input price when absent. */
  cachedInputUsdPerMillion?: number | undefined;
  audioUsdPerMinute?: number | undefined;
  revision: string;
}

export function estimateAiCostUsd(inputTokens: number | undefined, outputTokens: number | undefined, pricing: AiPricing | undefined, cachedInputTokens = 0): number | undefined {
  if (!pricing || pricing.inputUsdPerMillion === undefined || pricing.outputUsdPerMillion === undefined || inputTokens === undefined || outputTokens === undefined)
    return undefined;
  const cached = Math.min(Math.max(cachedInputTokens, 0), inputTokens);
  const cachedPrice = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  const value = ((inputTokens - cached) / 1_000_000) * pricing.inputUsdPerMillion + (cached / 1_000_000) * cachedPrice + (outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function estimateAudioCostUsd(durationSeconds: number, pricing: AiPricing | undefined): number | undefined {
  if (!pricing || pricing.audioUsdPerMinute === undefined) return undefined;
  return Math.round((durationSeconds / 60) * pricing.audioUsdPerMinute * 1_000_000) / 1_000_000;
}

export function aiBurstAllowed(input: { messagesLastHour: number; callsLastHour: number; maxMessagesPerHour: number; maxCallsPerHour: number }): boolean {
  return input.messagesLastHour < input.maxMessagesPerHour && input.callsLastHour < input.maxCallsPerHour;
}

export function shouldWarnMonthlySpend(input: { totalUsd: number; thresholdUsd: number; alreadyWarnedThisMonth: boolean }): boolean {
  return input.thresholdUsd > 0 && input.totalUsd >= input.thresholdUsd && !input.alreadyWarnedThisMonth;
}
