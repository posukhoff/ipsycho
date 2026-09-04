import { localWeekdayName } from "./time-presentation.js";
import { formatIsoInstantInTimezone, localDateAt, localDateTimeAt, shiftLocalDate } from "./timezone.js";

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

/**
 * The one line the model sees about the clock, all local:
 * "2026-09-04 14:05 (пятница), timezone Europe/Kyiv; today=2026-09-04, tomorrow=2026-09-05".
 */
export function formatCurrentTimeLine(now: Date, timezone: string): string {
  const parts = localDateTimeAt(now, timezone);
  const today = localDateAt(now, timezone);
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return `${today} ${time} (${localWeekdayName(now, timezone)}), timezone ${timezone}; today=${today}, tomorrow=${shiftLocalDate(today, 1)}`;
}
