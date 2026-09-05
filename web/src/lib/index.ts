/**
 * The data layer and the platform, in one import.
 *
 * ```ts
 * import { useQuery, useInfiniteQuery, useMutation, formatInstantTime, haptics } from "../../lib/index.js";
 * ```
 */
export {
  ApiProvider,
  useApiClient,
  useQueryCache,
  useQuery,
  useInfiniteQuery,
  useMutation,
  type QueryResult,
  type InfiniteResult,
  type MutationOptions,
  type MutationResult,
  type PagedEndpointName,
} from "./query.js";
export { QueryCache, queryKey, isRetryable, DEFAULT_RETRY, type CacheEntry, type QueryTarget, type RetryPolicy } from "./query-cache.js";
export {
  addMinutesToLocalTime,
  dayOffset,
  detectTimezone,
  formatInstantTime,
  formatLocalDate,
  formatTimeRange,
  formatUtcOffset,
  formatWeekday,
  instantToLocalDate,
  intlLocale,
  isoWeekday,
  minutesBetween,
  shiftLocalDate,
  type DayOffset,
} from "./format.js";
export {
  backButton,
  bootstrapTelegram,
  closeApp,
  colorScheme,
  haptics,
  initDataRaw,
  isInsideTelegram,
  onTelegramEvent,
  openExternal,
  safeAreaInsets,
  showMainButton,
  startParam,
  telegramLanguageCode,
  themeParams,
  viewportHeight,
  webApp,
  type ColorScheme,
  type TelegramWebApp,
} from "./telegram.js";
export { installTheme, themeVariables } from "./theme.js";
