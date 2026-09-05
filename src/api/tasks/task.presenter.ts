import { selectCardDetails } from "../../core/card-details.js";
import { isOverdueForDisplay, occurrenceLocalDate } from "../../core/local-schedule.js";
import { parseRecurrenceRule } from "../../core/recurrence.js";
import { rowLocalDate, type TaskGroup as DomainTaskGroup } from "../../core/task-list-view.js";
import type { TasksService } from "../../tasks/tasks.service.js";
import type { ContextService } from "../../context/context.service.js";
import type {
  ChecklistItem,
  FuzzySchedule,
  GoalTaskRow,
  OccurrenceDetail,
  OccurrenceSchedule,
  PausedSeriesRow,
  RecurrenceView,
  TaskGoalLink,
  TaskGroup,
  TaskJournalEntry,
  TaskListRow,
  TaskReminder,
} from "../contracts/index.js";

/**
 * The domain rows a screen reads, expressed as the contract.
 *
 * Nothing here decides anything: the grouping is `groupTaskRows`, the day a row belongs to is
 * `rowLocalDate`, the repeat is `parseRecurrenceRule`. What the file does own is the two answers the
 * bot computes while rendering and the web would otherwise have to recompute in the browser —
 * whether a line reads as overdue, and which local day it sits on — because both need the row's own
 * timezone and both are wrong the moment a phone in another zone answers them.
 *
 * The types are derived from the services rather than restated: `src/api/**` may not import the
 * schema, and a column added to `task_occurrences` should show up here without an edit.
 */

export type TaskRow = NonNullable<Awaited<ReturnType<TasksService["getTask"]>>>;
export type OccurrenceRow = NonNullable<Awaited<ReturnType<TasksService["findCurrentOccurrence"]>>>;
export type TaskEventRow = Awaited<ReturnType<TasksService["listTaskEvents"]>>[number];
export type ReminderRuleRow = Awaited<ReturnType<TasksService["listTaskReminders"]>>[number];
export type ChecklistRow =
  Awaited<ReturnType<TasksService["listChecklistsForContext"]>> extends Map<string, infer Rows> ? (Rows extends readonly (infer Row)[] ? Row : never) : never;
export type GoalRowRecord = NonNullable<Awaited<ReturnType<ContextService["findGoal"]>>>;
export type ScreenRow = { task: TaskRow; occurrence: OccurrenceRow | null };

const LIVE_OCCURRENCE_STATUSES = new Set(["scheduled", "open", "in_progress"]);

export function presentOccurrenceSchedule(occurrence: OccurrenceRow): OccurrenceSchedule {
  return {
    timezone: occurrence.timezone,
    plannedStartAt: instant(occurrence.plannedStartAt),
    plannedEndAt: instant(occurrence.plannedEndAt),
    plannedLocalDate: occurrence.plannedLocalDate ?? null,
    dueAt: instant(occurrence.dueAt),
    dueLocalDate: occurrence.dueLocalDate ?? null,
  };
}

/** A fuzzy task has no occurrence at all; its time is a horizon and the day it comes back. */
export function presentFuzzy(task: TaskRow): FuzzySchedule | null {
  if (task.timeMode !== "fuzzy") return null;
  return { horizonText: task.fuzzyHorizonText ?? null, reviewAt: instant(task.reviewAt), timezone: task.timezone };
}

export function presentListRow(row: ScreenRow, now: Date, nextReminderAt: Date | null): TaskListRow {
  const { task, occurrence } = row;
  return {
    taskId: task.id,
    taskVersion: task.version,
    occurrenceId: occurrence?.id ?? null,
    occurrenceVersion: occurrence?.version ?? null,
    title: task.title,
    importance: task.importance,
    kind: task.kind,
    taskStatus: task.status,
    timeMode: task.timeMode,
    timezone: task.timezone,
    occurrenceStatus: occurrence?.status ?? null,
    schedule: occurrence ? presentOccurrenceSchedule(occurrence) : null,
    fuzzy: presentFuzzy(task),
    localDate: rowLocalDate(row),
    overdue: occurrence ? isOverdueForDisplay(occurrence, now) : false,
    recurrenceRule: task.recurrenceRule ?? null,
    recurrenceEndLocalDate: task.recurrenceEndLocalDate ?? null,
    completedAt: instant(occurrence?.completedAt),
    completedLate: occurrence?.completedLate ?? false,
    nextReminderAt: instant(nextReminderAt),
  };
}

/**
 * `leadIndex` points into `rows` rather than repeating the lead row: the bot draws the collapsed
 * line, the app draws the same group expanded, and neither payload carries the lead twice.
 */
export function presentGroup(group: DomainTaskGroup<ScreenRow>, now: Date, reminders: ReadonlyMap<string, Date>): TaskGroup {
  const rows = group.rows.map((row) => presentListRow(row, now, (row.occurrence && reminders.get(row.occurrence.id)) ?? null));
  const leadIndex = Math.max(0, group.rows.indexOf(group.lead));
  return {
    key: group.key,
    title: group.title,
    importance: group.importance,
    recurrenceRule: group.recurrenceRule,
    rows,
    leadIndex,
    pastCount: group.pastCount,
  };
}

/** The stored rule already parsed, so no RRULE parser ships to the browser. */
export function presentRecurrence(task: TaskRow, excludedLocalDates: readonly string[]): RecurrenceView | null {
  if (!task.recurrenceRule) return null;
  let parsed;
  try {
    parsed = parseRecurrenceRule(task.recurrenceRule);
  } catch {
    // A stored rule the parser refuses cannot have produced the occurrences that exist, so this is
    // unreachable in practice. Saying «no repeat» is still better than failing the whole screen.
    return null;
  }
  return {
    rule: task.recurrenceRule,
    frequency: parsed.freq === "DAILY" ? "daily" : parsed.freq === "WEEKLY" ? "weekly" : "monthly",
    interval: parsed.interval,
    weekdays: [...(parsed.byDay ?? [])],
    monthDays: [...(parsed.byMonthDay ?? [])],
    localTimes: [...(parsed.byTime ?? [])],
    timezone: task.recurrenceTimezone ?? null,
    endLocalDate: task.recurrenceEndLocalDate ?? null,
    excludedLocalDates: [...excludedLocalDates],
    missPolicy: task.missPolicy ?? null,
  };
}

export function presentOccurrenceDetail(occurrence: OccurrenceRow, now: Date): OccurrenceDetail {
  return {
    id: occurrence.id,
    version: occurrence.version,
    status: occurrence.status,
    schedule: presentOccurrenceSchedule(occurrence),
    overdue: isOverdueForDisplay(occurrence, now),
    localDate: occurrenceLocalDate(occurrence),
    expiresAt: instant(occurrence.expiresAt),
    elapsedAt: instant(occurrence.elapsedAt),
    completedAt: instant(occurrence.completedAt),
    completedLate: occurrence.completedLate,
    skipReason: occurrence.skipReason ?? null,
    recurrenceKey: occurrence.recurrenceKey ?? null,
    dstAdjusted: occurrence.dstAdjusted,
  };
}

export function isLiveOccurrence(occurrence: OccurrenceRow): boolean {
  return LIVE_OCCURRENCE_STATUSES.has(occurrence.status);
}

export function presentChecklist(rows: readonly ChecklistRow[]): ChecklistItem[] {
  return rows.map((item) => ({ id: item.id, text: item.text, done: item.done }));
}

export function presentGoalLink(goal: GoalRowRecord | null): TaskGoalLink | null {
  return goal ? { id: goal.id, title: goal.title, version: goal.version } : null;
}

/**
 * The journal, with `details` withheld from anyone but its author. It is the user's own words —
 * a reschedule reason, a blocker note — and a workspace is not a reason to hand it to a second
 * member.
 */
export function presentJournal(events: readonly TaskEventRow[], viewerUserId: string): TaskJournalEntry[] {
  return events.map((event) => ({
    id: event.id,
    eventType: event.eventType,
    occurrenceId: event.occurrenceId ?? null,
    at: event.createdAt.toISOString(),
    details: event.actorUserId === viewerUserId ? (event.details ?? null) : null,
    byUser: event.actorUserId !== null,
  }));
}

export function presentReminders(rows: readonly ReminderRuleRow[]): TaskReminder[] {
  return rows.map(({ rule, nextAt }) => ({
    ruleId: rule.id,
    purpose: rule.purpose,
    origin: rule.origin === "explicit" ? "explicit" : "default",
    quietPolicy: rule.quietPolicy,
    nextAt: instant(nextAt),
    label: reminderLabel(rule),
  }));
}

function reminderLabel(rule: ReminderRuleRow["rule"]): TaskReminder["label"] {
  if (rule.triggerKind === "exact") return rule.exactAt ? { kind: "exact", at: rule.exactAt.toISOString() } : null;
  if (rule.triggerKind === "relative_timestamp") {
    const anchor = relativeAnchor(rule.anchor);
    return anchor && rule.offsetSeconds !== null ? { kind: "offset", anchor, offsetMinutes: Math.round(rule.offsetSeconds / 60) } : null;
  }
  if (rule.triggerKind === "local_date") {
    const anchor = rule.anchor === "due_at" ? "due_at" : rule.anchor === "planned_start" ? "planned_start" : null;
    return anchor && rule.daysOffset !== null && rule.localTime ? { kind: "local_date", anchor, daysOffset: rule.daysOffset, localTime: rule.localTime } : null;
  }
  return null;
}

function relativeAnchor(value: string | null): "planned_start" | "planned_end" | "due_at" | "review_at" | null {
  return value === "planned_start" || value === "planned_end" || value === "due_at" || value === "review_at" ? value : null;
}

/**
 * A paused series. `pausedAt` comes from the journal because `tasks` keeps no such column and
 * adding one would be a migration; `updated_at` would say «paused since» about an unrelated edit.
 */
export function presentPausedSeries(task: TaskRow, excludedLocalDates: readonly string[], pausedAt: Date | null): PausedSeriesRow {
  return {
    taskId: task.id,
    version: task.version,
    title: task.title,
    importance: task.importance,
    recurrence: presentRecurrence(task, excludedLocalDates),
    recurrenceRule: task.recurrenceRule ?? null,
    recurrenceEndLocalDate: task.recurrenceEndLocalDate ?? null,
    missPolicy: task.missPolicy ?? null,
    pausedAt: instant(pausedAt),
  };
}

/** One task on a goal's screen. The detail is the line `selectCardDetails` did not drop. */
export function presentGoalTaskRow(task: TaskRow, occurrence: OccurrenceRow | null, checklist: readonly ChecklistRow[], goalTitle: string, now: Date): GoalTaskRow {
  const details = selectCardDetails({
    title: task.title,
    why: task.why,
    nextAction: task.nextAction,
    context: task.context,
    checklist: checklist.map((item) => ({ text: item.text, done: item.done })),
    goalTitle,
  });
  return {
    taskId: task.id,
    occurrenceId: occurrence?.id ?? null,
    title: task.title,
    detail: details.nextAction ?? details.why ?? details.context,
    dueLocalDate: occurrence ? occurrenceLocalDate(occurrence) : (task.dueLocalDate ?? task.plannedLocalDate ?? null),
    importance: task.importance,
    status: task.status,
    overdue: occurrence ? isOverdueForDisplay(occurrence, now) : false,
  };
}

function instant(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}
