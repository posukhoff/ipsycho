import { formatIsoInstantInTimezone } from "./timezone.js";

/**
 * A stable, server-generated clock supplied to AI for one processing turn.
 * Callers own the Date instance so retries retain precisely the same reference.
 */
export function aiTimeContext(now: Date, timezone: string) {
  return {
    utc: now.toISOString(),
    local: formatIsoInstantInTimezone(now, timezone),
    timezone,
    epochMs: now.getTime(),
  };
}
