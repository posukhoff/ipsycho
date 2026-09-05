import { occurrenceLocalDate } from "./local-schedule.js";
import { compareLocalDates, shiftLocalDate } from "./timezone.js";

/**
 * How a list screen turns raw task rows into what the user reads: one line per thing to do,
 * inside a window of days the user chose. Two separate complaints live here.
 *
 * Duplication: a recurring series is materialized as many occurrences, the same task can hold
 * several times in one day, and the model may have created three unrelated task rows with the
 * same title. All three read as "the same thing" and collapse into one group keyed by title.
 *
 * Volume: every active occurrence used to be shown, including work from three weeks ago and
 * everything a daily series materialized a month ahead. A scope is a window of local days;
 * anything already in the past stays visible in every window, because dropping it would hide
 * work the user never closed.
 */
export type TaskScope = "overdue" | "today" | "week" | "month" | "all" | "nodate";

export const TASK_SCOPES: readonly TaskScope[] = ["overdue", "today", "week", "month", "all", "nodate"];

export const DEFAULT_TASK_SCOPE: TaskScope = "week";

const SCOPE_DAYS: Partial<Record<TaskScope, number>> = { today: 0, week: 7, month: 31 };

export type TaskImportance = "normal" | "required" | "critical";

export interface ListTask {
  id: string;
  title: string;
  importance: TaskImportance;
  recurrenceRule?: string | null;
  reviewAt?: Date | string | null;
  timezone: string;
}

export interface ListOccurrence {
  id: string;
  status?: string;
  timezone: string;
  overdue?: boolean | null;
  plannedStartAt?: Date | string | null;
  plannedEndAt?: Date | string | null;
  plannedLocalDate?: string | null;
  dueAt?: Date | string | null;
  dueLocalDate?: string | null;
}

export interface ListRow {
  task: ListTask;
  occurrence: ListOccurrence | null;
}

export interface TaskGroup<Row extends ListRow> {
  /** The id the collapsed line's button carries: the lead occurrence, or the task when there is none. */
  key: string;
  title: string;
  importance: TaskImportance;
  recurrenceRule: string | null;
  /** Every row that reads as this same thing, oldest first. */
  rows: Row[];
  /** The row the collapsed line describes: the nearest future one, else the most recent past one. */
  lead: Row;
  pastCount: number;
}

/** "  Позвонить   МАМЕ " and "Позвонить маме" are the same line to a reader, so they are one group. */
export function normalizeGroupTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/gu, " ");
}

/** The single local day a row belongs to, or null for fuzzy work and undated occurrences. */
export function rowLocalDate(row: ListRow): string | null {
  if (row.occurrence) return occurrenceLocalDate(row.occurrence);
  return null;
}

export function rowTime(row: ListRow): number {
  const value = row.occurrence?.plannedStartAt ?? row.occurrence?.dueAt ?? row.task.reviewAt ?? null;
  return value ? new Date(value).getTime() : Number.POSITIVE_INFINITY;
}

/** Dated before today. Today's own work that is already late is overdue, not stale. */
export function isStaleRow(row: ListRow, todayLocalDate: string): boolean {
  const localDate = rowLocalDate(row);
  return localDate !== null && compareLocalDates(localDate, todayLocalDate) < 0;
}

/** Work the user has already run past: flagged overdue, or dated before today. */
export function isPastRow(row: ListRow, todayLocalDate: string): boolean {
  return Boolean(row.occurrence?.overdue) || isStaleRow(row, todayLocalDate);
}

export function scopeMatches(row: ListRow, scope: TaskScope, todayLocalDate: string): boolean {
  if (scope === "all") return true;
  const localDate = rowLocalDate(row);
  if (scope === "nodate") return localDate === null;
  if (isPastRow(row, todayLocalDate)) return true;
  if (scope === "overdue") return false;
  if (localDate === null) return false;
  const days = SCOPE_DAYS[scope] ?? 0;
  return compareLocalDates(localDate, shiftLocalDate(todayLocalDate, days)) <= 0;
}

export function filterByScope<Row extends ListRow>(rows: readonly Row[], scope: TaskScope, todayLocalDate: string): Row[] {
  return rows.filter((row) => scopeMatches(row, scope, todayLocalDate));
}

export function groupTaskRows<Row extends ListRow>(rows: readonly Row[], todayLocalDate: string): Array<TaskGroup<Row>> {
  const byTitle = new Map<string, Row[]>();
  for (const row of rows) {
    const key = normalizeGroupTitle(row.task.title);
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(row);
    else byTitle.set(key, [row]);
  }
  const groups: Array<TaskGroup<Row>> = [];
  for (const bucket of byTitle.values()) {
    const sorted = [...bucket].sort((left, right) => rowTime(left) - rowTime(right));
    const past = sorted.filter((row) => isPastRow(row, todayLocalDate));
    const lead = sorted.find((row) => !isPastRow(row, todayLocalDate)) ?? past[past.length - 1] ?? sorted[0]!;
    const series = sorted.find((row) => row.task.recurrenceRule)?.task.recurrenceRule ?? null;
    groups.push({
      key: lead.occurrence?.id ?? lead.task.id,
      title: lead.task.title,
      importance: sorted.some((row) => row.task.importance === "critical") ? "critical" : sorted.some((row) => row.task.importance === "required") ? "required" : "normal",
      recurrenceRule: series,
      rows: sorted,
      lead,
      pastCount: past.length,
    });
  }
  return groups.sort((left, right) => compareGroups(left, right, todayLocalDate));
}

/**
 * Overdue work first, then by the day it is due. Importance only breaks ties inside a day:
 * ordering by importance first is what used to lift a critical task a month away above today.
 */
export function compareGroups(left: TaskGroup<ListRow>, right: TaskGroup<ListRow>, todayLocalDate: string): number {
  const leftPast = isPastRow(left.lead, todayLocalDate) ? 0 : 1;
  const rightPast = isPastRow(right.lead, todayLocalDate) ? 0 : 1;
  if (leftPast !== rightPast) return leftPast - rightPast;
  const leftDate = rowLocalDate(left.lead);
  const rightDate = rowLocalDate(right.lead);
  if (leftDate !== rightDate) {
    if (leftDate === null) return 1;
    if (rightDate === null) return -1;
    const byDate = compareLocalDates(leftDate, rightDate);
    if (byDate !== 0) return byDate;
  }
  const byImportance = importanceRank(left.importance) - importanceRank(right.importance);
  if (byImportance !== 0) return byImportance;
  return rowTime(left.lead) - rowTime(right.lead);
}

/** How many groups each filter button would show, for the badge on the button. */
export function scopeCounts<Row extends ListRow>(rows: readonly Row[], todayLocalDate: string): Record<TaskScope, number> {
  const counts = {} as Record<TaskScope, number>;
  for (const scope of TASK_SCOPES) counts[scope] = groupTaskRows(filterByScope(rows, scope, todayLocalDate), todayLocalDate).length;
  return counts;
}

export function paginate<Item>(items: readonly Item[], page: number, pageSize: number): { items: Item[]; page: number; pages: number; rest: number } {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const start = current * pageSize;
  return { items: items.slice(start, start + pageSize), page: current, pages, rest: Math.max(0, items.length - start - pageSize) };
}

function importanceRank(importance: TaskImportance): number {
  return importance === "critical" ? 0 : importance === "required" ? 1 : 2;
}
