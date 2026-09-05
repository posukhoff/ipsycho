import { compareLocalDates, parseLocalDate, shiftLocalDate } from "./timezone.js";

/**
 * The week pool. A task with no date waits here; once a week the user takes some of them for the
 * coming week. The mark is the Monday of that week as a local date, which is what makes a stale
 * mark unrepresentable: a pick counts only while it names the current week, so nothing has to
 * clear it, and a mark from a past week is still readable as "taken and never started".
 */

/** How many tasks one week may hold. A pool that fits on one screen is the point of the pool. */
export const WEEK_PICK_LIMIT = 7;

/** ISO weekday of a local date: 1 is Monday, 7 is Sunday. */
export function localWeekday(localDate: string): number {
  const { year, month, day } = parseLocalDate(localDate);
  const utc = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return utc === 0 ? 7 : utc;
}

/** Monday of the week containing this local date. */
export function mondayOf(localDate: string): string {
  return shiftLocalDate(localDate, 1 - localWeekday(localDate));
}

/** The week a pick made today belongs to: this week, since the day it is taken into is inside it. */
export function currentWeekStart(todayLocalDate: string): string {
  return mondayOf(todayLocalDate);
}

/** A pick counts only while it names the week today belongs to. */
export function isPickLive(pickedWeekStart: string | null | undefined, todayLocalDate: string): boolean {
  return Boolean(pickedWeekStart) && pickedWeekStart === currentWeekStart(todayLocalDate);
}

/** A pick from an earlier week: the task was taken and never closed. */
export function isPickStale(pickedWeekStart: string | null | undefined, todayLocalDate: string): boolean {
  return Boolean(pickedWeekStart) && compareLocalDates(pickedWeekStart!, currentWeekStart(todayLocalDate)) < 0;
}

/** Monday and Sunday of the week before the one today belongs to, for the weekly summary. */
export function previousWeekRange(todayLocalDate: string): { start: string; end: string } {
  const start = shiftLocalDate(currentWeekStart(todayLocalDate), -7);
  return { start, end: shiftLocalDate(start, 6) };
}

export function isWithinLocalRange(localDate: string, range: { start: string; end: string }): boolean {
  return compareLocalDates(localDate, range.start) >= 0 && compareLocalDates(localDate, range.end) <= 0;
}

/**
 * Ordering for the pick screen: what was taken and left undone first, because that is the decision
 * the user is avoiding; then the rest of the pool by importance and age.
 */
export function comparePoolRows<T extends { pickedWeekStart?: string | null; importance: "normal" | "required" | "critical"; updatedAt?: Date | string | null }>(
  todayLocalDate: string,
): (a: T, b: T) => number {
  const rank = (row: T) => (isPickStale(row.pickedWeekStart, todayLocalDate) ? 0 : isPickLive(row.pickedWeekStart, todayLocalDate) ? 1 : 2);
  const weight = { critical: 0, required: 1, normal: 2 } as const;
  return (a, b) => {
    const byPick = rank(a) - rank(b);
    if (byPick !== 0) return byPick;
    const byImportance = weight[a.importance] - weight[b.importance];
    if (byImportance !== 0) return byImportance;
    return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
  };
}
