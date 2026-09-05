import { parseLocalDate, shiftLocalDate } from "./timezone.js";

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

/**
 * The week a pick made today is for. Sunday is the day the week card arrives, and a pick made then
 * is meant for the week that starts tomorrow — stamping today's Monday made it read as last week's
 * unfinished work the moment Monday came.
 */
export function targetWeekStart(todayLocalDate: string): string {
  return localWeekday(todayLocalDate) === 7 ? mondayOf(shiftLocalDate(todayLocalDate, 1)) : mondayOf(todayLocalDate);
}

/** A pick counts only while it names the week it was made for. */
export function isPickLive(pickedWeekStart: string | null | undefined, todayLocalDate: string): boolean {
  return Boolean(pickedWeekStart) && pickedWeekStart === targetWeekStart(todayLocalDate);
}

/** A pick from the week before this one: taken and never given a day. Older marks stop being news. */
export function isPickStale(pickedWeekStart: string | null | undefined, todayLocalDate: string): boolean {
  return Boolean(pickedWeekStart) && pickedWeekStart === shiftLocalDate(targetWeekStart(todayLocalDate), -7);
}

/** The week that just ended, relative to the week a pick made today is for. */
export function previousWeekRange(todayLocalDate: string): { start: string; end: string } {
  const start = shiftLocalDate(targetWeekStart(todayLocalDate), -7);
  return { start, end: shiftLocalDate(start, 6) };
}

/**
 * Ordering for the pick screen: a task whose day has already passed first, then what was taken and
 * left undone, because those are the decisions the user is avoiding; then the rest by importance.
 */
export function comparePoolRows<T extends { title: string; pickedWeekStart?: string | null; importance: "normal" | "required" | "critical"; overdue?: boolean }>(
  todayLocalDate: string,
): (a: T, b: T) => number {
  // Ordering never depends on whether a row is picked: the screen redraws after every tap, and a
  // row that jumps means the next tap lands on a different task.
  const rank = (row: T) => (row.overdue ? 0 : isPickStale(row.pickedWeekStart, todayLocalDate) ? 1 : 2);
  const weight = { critical: 0, required: 1, normal: 2 } as const;
  return (a, b) => rank(a) - rank(b) || weight[a.importance] - weight[b.importance] || a.title.localeCompare(b.title);
}
