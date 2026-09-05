import { localDateTimeAt } from "../../core/timezone.js";
import { resolveTimezoneInput } from "../../core/timezone-lookup.js";
import type { TimezoneSuggestion } from "../contracts/index.js";

/**
 * The timezone picker's search, answered on the server.
 *
 * The client ships no timezone table: a full IANA list with offsets is ~600 rows that go stale
 * twice a year, and the browser already has the data — but only the runtime's, which on an old
 * Android webview is not the runtime that will schedule the reminder. The zone that matters is the
 * one Node resolves, so Node answers.
 *
 * Two sources, in this order: the city dictionary `/timezone` already uses — «киев», «warsaw» — so
 * the app and the command understand the same words, then a substring match over the IANA ids.
 */
const ZONES: readonly string[] = readSupportedTimezones();

/** `Intl.supportedValuesOf` is ES2024 and the project's lib is ES2022; Node 24 has it at runtime. */
function readSupportedTimezones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supported !== "function") return [];
  try {
    return supported("timeZone");
  } catch {
    return [];
  }
}

export function searchTimezones(query: string, now: Date, limit = 20): TimezoneSuggestion[] {
  const needle = query.trim().toLowerCase().replace(/\s+/gu, " ");
  if (!needle) return [];

  const ids: string[] = [];
  const add = (zone: string): void => {
    if (ids.length < limit && !ids.includes(zone)) ids.push(zone);
  };

  // The exact answer first, so «киев» resolves to Europe/Kyiv rather than to nothing at all: no
  // IANA id contains the Cyrillic name, and a substring search alone would refuse every city word.
  const resolved = resolveTimezoneInput(query);
  if (resolved) add(resolved);

  const haystack = needle.replace(/[\s-]+/gu, "_");
  for (const zone of ZONES) {
    if (zone.toLowerCase().includes(haystack)) add(zone);
    if (ids.length >= limit) break;
  }

  return ids.flatMap((id) => {
    const suggestion = describeZone(id, now);
    return suggestion ? [suggestion] : [];
  });
}

/** A zone the runtime cannot format is dropped rather than crashing the whole search. */
function describeZone(id: string, now: Date): TimezoneSuggestion | null {
  try {
    const local = localDateTimeAt(now, id);
    const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    // `now` carries milliseconds and the formatted parts do not; truncating both to the second keeps
    // the difference an exact multiple of a minute for every zone, including the :45 ones.
    const offsetMinutes = Math.round((asUtc - Math.floor(now.getTime() / 1000) * 1000) / 60_000);
    if (offsetMinutes < -840 || offsetMinutes > 840) return null;
    return { id, offsetMinutes, localTime: `${pad(local.hour)}:${pad(local.minute)}` };
  } catch {
    return null;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
