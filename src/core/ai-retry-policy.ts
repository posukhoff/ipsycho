const AUTOMATIC_RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;

/**
 * Returns the next durable retry time after a failed high-level AI attempt.
 * retryCount is the persisted failure count after incrementing it.
 * Initial attempt + two automatic retries = at most three high-level attempts.
 */
export function nextAutomaticAiRetryAt(retryCount: number, now: Date): Date | null {
  if (!Number.isInteger(retryCount) || retryCount < 1) throw new Error("retryCount must be a positive integer");
  const delay = AUTOMATIC_RETRY_DELAYS_MS[retryCount - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay);
}

export function automaticAiRetryLimit(): number {
  return AUTOMATIC_RETRY_DELAYS_MS.length;
}
