/**
 * The data layer and the platform, in one import.
 *
 * ```ts
 * import { useQuery, useInfiniteQuery, useMutation, formatInstantTime, haptics } from "../../lib/index.js";
 * ```
 *
 * Only what a screen actually reaches for. `ApiProvider`, `installTheme`, `bootstrapTelegram` and
 * the rest of `telegram.ts` are wiring: `app/` and `ui/` import those from the concrete file, and a
 * barrel that also re-exported them was a second name for everything with no second reader.
 */
export { useInfiniteQuery, useMutation, useQuery, useQueryCache } from "./query.js";
export { QueryCache } from "./query-cache.js";
export { addMinutesToLocalTime, dayOffset, detectTimezone, formatInstantTime, formatLocalDate, formatUtcOffset, formatWeekday, instantToLocalDate } from "./format.js";
export { haptics } from "./telegram.js";
