import { assessAvoidance, deriveAvoidanceSignals } from "./avoidance.js";
import { assignShortIds, buildRefMap, type RefMap } from "./ai-refs.js";
import { habitOfferEligible } from "./habit-policy.js";
import { recurrenceLabel } from "./recurrence-label.js";
import { reviewQuestionLimit, type ReviewKind } from "./review-policy.js";
import { formatLocalDateTime, formatWhenForModel, type PresentationLocale } from "./time-presentation.js";
import { startOfLocalDateUtc } from "./timezone.js";
import type { Importance, OccurrenceStatus, TaskKind, TaskStatus, TimeMode } from "./types.js";
import type { WeeklyReviewState } from "./weekly-review-state.js";

/**
 * Everything the model reads about the workspace on one turn. Short ids only, local
 * pre-formatted times only, one line per task; the server keeps the UUIDs in `RefMap`.
 * Keys are emitted only when they carry information, so the JSON stays compact.
 */
export interface ModelTaskLine {
  id: string;
  title: string;
  when: string;
  importance?: Extract<Importance, "required" | "critical">;
  kind?: "event";
  repeat?: string;
  state?: "in_progress" | "overdue" | "paused_series" | "seen";
  goal?: string;
  checklist?: string;
  blocker?: string;
  avoided?: true;
}

export interface ModelGoalLine {
  id: string;
  title: string;
  why?: string;
  status?: "paused" | "completed";
  targetDate?: string;
  tasks?: string[];
}

export interface ModelMemoryLine { id: string; type: string; content: string }

export interface ModelSettings {
  timezone: string;
  language: string;
  morningDigest: string;
  eveningDigest: string;
  weeklyReview: string;
  quietHours: string;
  snoozedUntil?: string;
  reminderDefaults: {
    eventOffsetsMinutes: number[];
    plannedTaskOffsetMinutes: number;
    criticalPostDueMinutes: number;
    seenNormalMinutes: number;
    seenRequiredMinutes: number;
    seenCriticalMinutes: number;
  };
}

export type ModelHint =
  | { task: string; kind: "avoidance" }
  | { task: string; kind: "habit_offer" }
  | { task: string; kind: "reschedule_requested" | "blocker_recorded" };

export interface ModelReview {
  kind: ReviewKind;
  questionsAsked: number;
  questionLimit: number;
  snapshot?: string;
  state?: Omit<WeeklyReviewState, "version">;
}

export interface ModelContext {
  tasks: ModelTaskLine[];
  tasksNote?: string;
  goals: ModelGoalLine[];
  memory: ModelMemoryLine[];
  settings: ModelSettings | null;
  topic: {
    active: { title: string; summary: string; review?: ReviewKind } | null;
    recent: Array<{ title: string; summary: string }>;
  };
  pendingProposal?: { askedAt: string; items: string[] };
  hints?: ModelHint[];
  review?: ModelReview;
}

/** The subset of a persisted task row the context reads; database rows satisfy it structurally. */
export interface ContextTaskRow {
  id: string;
  version: number;
  title: string;
  why?: string | null;
  kind: TaskKind;
  importance: Importance;
  status: TaskStatus;
  timeMode: TimeMode;
  timezone: string;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  plannedLocalDate: string | null;
  dueAt: Date | null;
  dueLocalDate: string | null;
  fuzzyHorizonText: string | null;
  reviewAt: Date | null;
  recurrenceRule: string | null;
  recurrenceEndLocalDate?: string | null;
  habitMode?: boolean;
  habitOfferSentAt?: Date | null;
}

export interface ContextOccurrenceRow {
  id: string;
  taskId: string;
  status: OccurrenceStatus;
  timezone: string;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  plannedLocalDate: string | null;
  dueAt: Date | null;
  dueLocalDate: string | null;
  overdue?: boolean;
}

export interface ContextGoalRow {
  id: string;
  version: number;
  title: string;
  why: string | null;
  status: "active" | "paused" | "completed" | "cancelled";
  targetLocalDate: string | null;
}

export interface ContextMemoryRow { id: string; version: number; type: string; content: string; sensitive: boolean }

export interface ContextTopicRow {
  id: string;
  title: string;
  summary: string;
  status: "active" | "paused" | "resolved" | "abandoned";
  reviewKind: string | null;
  clarificationCount: number;
  lastMessageAt: Date;
}

export interface ContextSettingsRow {
  timezone: string;
  pinnedLanguage: string | null;
  morningDigestEnabled: boolean;
  morningReferenceTime: string;
  eveningDigestEnabled: boolean;
  eveningReferenceTime: string;
  weeklyReviewEnabled: boolean;
  weeklyReviewWeekday: number;
  weeklyReviewTime: string;
  quietHoursEnabled: boolean;
  weekdayQuietStart: string;
  weekdayQuietEnd: string;
  weekendQuietStart: string;
  weekendQuietEnd: string;
  notificationsSnoozedUntil: Date | null;
  eventReminderOffsetsMinutes: unknown;
  plannedTaskReminderOffsetMinutes: number;
  criticalPostDueMinutes: number;
  seenNormalMinutes: number;
  seenRequiredMinutes: number;
  seenCriticalMinutes: number;
}

export interface TaskSelection<T extends ContextTaskRow = ContextTaskRow> { shown: T[]; total: number; truncated: boolean }

export interface SelectTasksOptions { now: Date; timezone: string; limit?: number; nearest?: number }

const DEFAULT_LIMIT = 60;
const DEFAULT_NEAREST = 40;

/** in_progress before open before scheduled; inside a status, the earliest anchor first. */
const OCCURRENCE_PRIORITY: Partial<Record<OccurrenceStatus, number>> = { in_progress: 0, open: 1, scheduled: 2 };

export function currentOccurrence<O extends ContextOccurrenceRow>(occurrences: readonly O[] | undefined): O | null {
  if (!occurrences?.length) return null;
  return [...occurrences]
    .filter((occurrence) => occurrence.status in OCCURRENCE_PRIORITY)
    .sort((a, b) => (OCCURRENCE_PRIORITY[a.status] ?? 9) - (OCCURRENCE_PRIORITY[b.status] ?? 9) || compareAnchors(occurrenceAnchor(a), occurrenceAnchor(b)))[0] ?? null;
}

function occurrenceAnchor(occurrence: ContextOccurrenceRow): number | null {
  const exact = occurrence.plannedStartAt ?? occurrence.dueAt;
  if (exact) return exact.getTime();
  const localDate = occurrence.plannedLocalDate ?? occurrence.dueLocalDate;
  return localDate ? startOfLocalDateUtc(localDate, occurrence.timezone).date.getTime() : null;
}

/** The instant a task is sorted by: its nearest live occurrence, a fuzzy task's review date, else the task's own fields. */
export function taskAnchor(task: ContextTaskRow, occurrences: readonly ContextOccurrenceRow[] | undefined): number | null {
  const live = (occurrences ?? []).map(occurrenceAnchor).filter((value): value is number => value !== null);
  if (live.length) return Math.min(...live);
  if (task.timeMode === "fuzzy") return task.reviewAt?.getTime() ?? null;
  const exact = task.plannedStartAt ?? task.dueAt;
  if (exact) return exact.getTime();
  const localDate = task.plannedLocalDate ?? task.dueLocalDate;
  return localDate ? startOfLocalDateUtc(localDate, task.timezone).date.getTime() : null;
}

function compareAnchors(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** Of the `nearest` slots, this share goes to the most recently overdue tasks; the rest to what comes next. */
const OVERDUE_SHARE = 0.25;

/**
 * All active tasks fit under `limit`; beyond it the model sees the `nearest` by time plus
 * every full-text match for the message, all sorted by time so `t1` is the nearest task.
 * "Nearest" is split between the most recently overdue and the soonest upcoming: sorting by
 * anchor alone let a backlog of old overdue tasks push this week's work out of the context.
 */
export function selectTasksForContext<T extends ContextTaskRow>(
  tasks: readonly T[],
  occurrencesByTask: ReadonlyMap<string, readonly ContextOccurrenceRow[]>,
  ftsMatchIds: ReadonlySet<string>,
  opts: SelectTasksOptions,
): TaskSelection<T> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const nearest = opts.nearest ?? DEFAULT_NEAREST;
  const anchored = tasks
    .map((task) => ({ task, anchor: taskAnchor(task, occurrencesByTask.get(task.id)) }))
    .sort((a, b) => compareAnchors(a.anchor, b.anchor) || a.task.title.localeCompare(b.task.title, "ru") || a.task.id.localeCompare(b.task.id));
  const sorted = anchored.map(({ task }) => task);
  if (sorted.length <= limit) return { shown: sorted, total: sorted.length, truncated: false };

  const nowMs = opts.now.getTime();
  const overdue = anchored.filter(({ anchor }) => anchor !== null && anchor < nowMs);
  const upcoming = anchored.filter(({ anchor }) => anchor === null || anchor >= nowMs);
  const overdueSlots = Math.min(overdue.length, Math.floor(nearest * OVERDUE_SHARE));
  const upcomingSlots = Math.min(upcoming.length, nearest - overdueSlots);
  const keep = new Set<string>();
  for (const { task } of overdue.slice(overdue.length - overdueSlots)) keep.add(task.id);
  for (const { task } of upcoming.slice(0, upcomingSlots)) keep.add(task.id);
  // Slots one side could not fill go to the other side.
  for (const { task } of [...overdue.slice(0, overdue.length - overdueSlots).reverse(), ...upcoming.slice(upcomingSlots)]) {
    if (keep.size >= nearest) break;
    keep.add(task.id);
  }
  for (const id of ftsMatchIds) keep.add(id);
  const shown = sorted.filter((task) => keep.has(task.id));
  return { shown, total: sorted.length, truncated: shown.length < sorted.length };
}

export function tasksNote(total: number, shown: number, locale: PresentationLocale = "ru"): string {
  if (locale === "en") return `Showing ${shown} of ${total} active tasks: the nearest by time and the matches for the message. If the needed one is missing, ask for its exact title.`;
  if (locale === "uk") return `Показано ${shown} із ${total} активних завдань: найближчі за часом і збіги з повідомленням. Якщо потрібного немає — попроси уточнити назву.`;
  return `Показаны ${shown} из ${total} активных задач: ближайшие по времени и совпадения с сообщением. Если нужной нет — попроси уточнить название.`;
}

export interface TurnContextInput {
  now: Date;
  timezone: string;
  tasks: readonly ContextTaskRow[];
  tasksTotal: number;
  truncated: boolean;
  occurrencesByTask: ReadonlyMap<string, readonly ContextOccurrenceRow[]>;
  checklistByTask?: ReadonlyMap<string, ReadonlyArray<{ done: boolean }>>;
  goals: readonly ContextGoalRow[];
  taskGoalLinks: ReadonlyArray<{ taskId: string; goalId: string }>;
  profile: readonly ContextMemoryRow[];
  memoryMatches: readonly ContextMemoryRow[];
  settings: ContextSettingsRow | null;
  topics: readonly ContextTopicRow[];
  /** Interaction event types per occurrence id, oldest first, as `listAvoidanceEvents` returns them. */
  eventTypesByOccurrence?: ReadonlyMap<string, readonly string[]>;
  /** Newest first; the first entry per task becomes its `blocker` line. */
  blockers?: ReadonlyArray<{ taskId: string; details: string | null }>;
  pendingProposal?: { createdAt: Date; titles: readonly string[] } | null;
  focus?: { taskId: string; action: "reschedule" | "blocker" } | null;
  review?: { kind: ReviewKind; questionsAsked: number; snapshot?: string; state?: WeeklyReviewState | null } | null;
  /** The user's interface language; the context's own words (weekdays, notes) follow it so the payload does not pull the model toward Russian. */
  locale?: PresentationLocale;
}

export interface ComposedTurnContext { model: ModelContext; refs: RefMap }

const WEEKDAY_SHORT: Record<PresentationLocale, readonly string[]> = {
  ru: ["пн", "вт", "ср", "чт", "пт", "сб", "вс"],
  uk: ["пн", "вт", "ср", "чт", "пт", "сб", "нд"],
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
};
const WEEKEND_WORD: Record<PresentationLocale, string> = { ru: "выходные", uk: "вихідні", en: "weekends" };
const MEMORY_MATCH_LIMIT = 5;

export function composeTurnContext(input: TurnContextInput): ComposedTurnContext {
  const locale = input.locale ?? "ru";
  const taskEntries = assignShortIds("tasks", input.tasks);
  const shortIdByTask = new Map(taskEntries.map((task) => [task.id, task.shortId]));
  const goalEntries = assignShortIds("goals", input.goals);
  const shortIdByGoal = new Map(goalEntries.map((goal) => [goal.id, goal.shortId]));

  // Sensitive facts are durable local records, not AI context: neither retrieval nor a
  // prompt injection can make the provider enumerate them.
  const memoryRows: ContextMemoryRow[] = [];
  const seenMemory = new Set<string>();
  for (const item of input.profile) {
    if (item.sensitive || seenMemory.has(item.id)) continue;
    seenMemory.add(item.id);
    memoryRows.push(item);
  }
  let matches = 0;
  for (const item of input.memoryMatches) {
    if (item.sensitive || seenMemory.has(item.id) || matches >= MEMORY_MATCH_LIMIT) continue;
    seenMemory.add(item.id);
    memoryRows.push(item);
    matches += 1;
  }
  const memoryEntries = assignShortIds("memory", memoryRows);

  const goalByTask = new Map<string, string>();
  const tasksByGoal = new Map<string, string[]>();
  for (const link of input.taskGoalLinks) {
    const taskShortId = shortIdByTask.get(link.taskId);
    const goalShortId = shortIdByGoal.get(link.goalId);
    if (!taskShortId || !goalShortId) continue;
    if (!goalByTask.has(link.taskId)) goalByTask.set(link.taskId, goalShortId);
    const list = tasksByGoal.get(link.goalId) ?? [];
    if (!list.includes(taskShortId)) list.push(taskShortId);
    tasksByGoal.set(link.goalId, list);
  }

  const blockerByTask = new Map<string, string>();
  for (const blocker of input.blockers ?? []) {
    const details = blocker.details?.trim();
    if (details && !blockerByTask.has(blocker.taskId)) blockerByTask.set(blocker.taskId, details);
  }

  const hints: ModelHint[] = [];
  const tasks: ModelTaskLine[] = taskEntries.map((task) => {
    const occurrences = input.occurrencesByTask.get(task.id) ?? [];
    const current = currentOccurrence(occurrences);
    const signals = current ? deriveAvoidanceSignals(input.eventTypesByOccurrence?.get(current.id) ?? []) : null;
    const line: ModelTaskLine = {
      id: task.shortId,
      title: task.title,
      when: formatWhenForModel(current ?? task, input.timezone, input.now, locale),
    };
    if (task.importance !== "normal") line.importance = task.importance;
    if (task.kind === "event") line.kind = "event";
    const repeat = recurrenceLabel(task.recurrenceRule, task.recurrenceEndLocalDate ?? null, locale);
    if (repeat) line.repeat = repeat;
    const state = taskState(task, current, signals?.seenWithoutStart ?? 0, input.now);
    if (state) line.state = state;
    const goal = goalByTask.get(task.id);
    if (goal) line.goal = goal;
    const checklist = input.checklistByTask?.get(task.id);
    if (checklist?.length) line.checklist = `${checklist.filter((item) => item.done).length}/${checklist.length}`;
    const blocker = blockerByTask.get(task.id);
    if (blocker) line.blocker = blocker;
    if (signals && assessAvoidance(signals).detected) {
      line.avoided = true;
      hints.push({ task: task.shortId, kind: "avoidance" });
    }
    if (habitOfferEligible({
      recurring: Boolean(task.recurrenceRule),
      kind: task.kind,
      alreadyHabit: Boolean(task.habitMode),
      offeredBefore: Boolean(task.habitOfferSentAt),
      behavioral: true, // semantic suitability is the model's call; this gate enforces frequency/type rules.
    })) hints.push({ task: task.shortId, kind: "habit_offer" });
    return line;
  });
  if (input.focus) {
    const focused = shortIdByTask.get(input.focus.taskId);
    if (focused) hints.push({ task: focused, kind: input.focus.action === "reschedule" ? "reschedule_requested" : "blocker_recorded" });
  }

  const goals: ModelGoalLine[] = goalEntries.map((goal) => {
    const line: ModelGoalLine = { id: goal.shortId, title: goal.title };
    if (goal.why?.trim()) line.why = goal.why.trim();
    if (goal.status === "paused" || goal.status === "completed") line.status = goal.status;
    if (goal.targetLocalDate) line.targetDate = goal.targetLocalDate;
    const linked = tasksByGoal.get(goal.id);
    if (linked?.length) line.tasks = linked;
    return line;
  });

  const active = input.topics.find((topic) => topic.status === "active") ?? null;
  const recent = input.topics
    .filter((topic) => topic.status === "paused" && (topic.title || topic.summary))
    .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
    .slice(0, 3)
    .map((topic) => ({ title: topic.title, summary: topic.summary }));

  const model: ModelContext = {
    tasks,
    ...(input.truncated ? { tasksNote: tasksNote(input.tasksTotal, tasks.length, locale) } : {}),
    goals,
    memory: memoryEntries.map((item) => ({ id: item.shortId, type: item.type, content: item.content })),
    settings: input.settings ? modelSettings(input.settings, input.now, locale) : null,
    topic: {
      active: active ? {
        title: active.title,
        summary: active.summary,
        ...(active.reviewKind === "evening" || active.reviewKind === "weekly" ? { review: active.reviewKind } : {}),
      } : null,
      recent,
    },
    ...(input.pendingProposal ? {
      pendingProposal: { askedAt: formatLocalDateTime(input.pendingProposal.createdAt, input.timezone, input.now), items: [...input.pendingProposal.titles] },
    } : {}),
    ...(hints.length ? { hints } : {}),
    ...(input.review ? { review: modelReview(input.review) } : {}),
  };

  const refs = buildRefMap({
    tasks: taskEntries.map((task) => ({
      shortId: task.shortId, id: task.id, version: task.version, title: task.title, timeMode: task.timeMode, recurring: Boolean(task.recurrenceRule), status: task.status,
    })),
    goals: goalEntries.map((goal) => ({ shortId: goal.shortId, id: goal.id, version: goal.version, title: goal.title })),
    memory: memoryEntries.map((item) => ({ shortId: item.shortId, id: item.id, version: item.version, title: item.content })),
  });
  return { model, refs };
}

function taskState(task: ContextTaskRow, current: ContextOccurrenceRow | null, seenWithoutStart: number, now: Date): ModelTaskLine["state"] | null {
  if (task.status === "paused") return "paused_series";
  if (!current) return null;
  if (current.status === "in_progress") return "in_progress";
  const due = current.dueAt ?? current.plannedEndAt ?? (current.plannedStartAt && task.timeMode === "point" ? current.plannedStartAt : null);
  if (current.overdue || (due !== null && due.getTime() < now.getTime())) return "overdue";
  if (seenWithoutStart > 0) return "seen";
  return null;
}

function modelSettings(settings: ContextSettingsRow, now: Date, locale: PresentationLocale): ModelSettings {
  const offsets = Array.isArray(settings.eventReminderOffsetsMinutes)
    ? settings.eventReminderOffsetsMinutes.filter((value): value is number => typeof value === "number")
    : [];
  return {
    timezone: settings.timezone,
    language: settings.pinnedLanguage?.trim() || "auto",
    morningDigest: settings.morningDigestEnabled ? settings.morningReferenceTime : "off",
    eveningDigest: settings.eveningDigestEnabled ? settings.eveningReferenceTime : "off",
    weeklyReview: settings.weeklyReviewEnabled ? `${WEEKDAY_SHORT[locale][settings.weeklyReviewWeekday - 1] ?? WEEKDAY_SHORT[locale][6]} ${settings.weeklyReviewTime}` : "off",
    quietHours: settings.quietHoursEnabled
      ? `${settings.weekdayQuietStart}–${settings.weekdayQuietEnd}, ${WEEKEND_WORD[locale]} ${settings.weekendQuietStart}–${settings.weekendQuietEnd}`
      : "off",
    ...(settings.notificationsSnoozedUntil && settings.notificationsSnoozedUntil.getTime() > now.getTime()
      ? { snoozedUntil: formatLocalDateTime(settings.notificationsSnoozedUntil, settings.timezone, now) }
      : {}),
    reminderDefaults: {
      eventOffsetsMinutes: offsets,
      plannedTaskOffsetMinutes: settings.plannedTaskReminderOffsetMinutes,
      criticalPostDueMinutes: settings.criticalPostDueMinutes,
      seenNormalMinutes: settings.seenNormalMinutes,
      seenRequiredMinutes: settings.seenRequiredMinutes,
      seenCriticalMinutes: settings.seenCriticalMinutes,
    },
  };
}

function modelReview(review: NonNullable<TurnContextInput["review"]>): ModelReview {
  const result: ModelReview = { kind: review.kind, questionsAsked: review.questionsAsked, questionLimit: reviewQuestionLimit(review.kind) };
  if (review.snapshot?.trim()) result.snapshot = review.snapshot;
  if (review.state) {
    const { version: _version, ...state } = review.state;
    result.state = state;
  }
  return result;
}

/** Characters of serialized context one turn may carry; roughly 6k tokens. */
export const MODEL_CONTEXT_MAX_CHARS = 24_000;
const MEMORY_CONTENT_TRIMMED = 300;
const TASKS_MINIMUM = 20;

/**
 * Trims the context to a byte budget in a fixed order of decreasing dispensability: paused
 * topic summaries, long memory notes, then task lines from the far end of the list. Nothing
 * else bounded the context; thirty memory items of two thousand characters alone exceeded it.
 */
export function budgetModelContext(model: ModelContext, maxChars = MODEL_CONTEXT_MAX_CHARS, locale: PresentationLocale = "ru"): ModelContext {
  const size = (value: ModelContext): number => JSON.stringify(value).length;
  if (size(model) <= maxChars) return model;
  let current: ModelContext = { ...model, topic: { ...model.topic, recent: [] } };
  if (size(current) <= maxChars) return current;
  current = {
    ...current,
    memory: current.memory.map((item) => item.content.length > MEMORY_CONTENT_TRIMMED
      ? { ...item, content: `${item.content.slice(0, MEMORY_CONTENT_TRIMMED - 1).trimEnd()}…` }
      : item),
  };
  if (size(current) <= maxChars) return current;
  const total = model.tasks.length;
  let tasks = current.tasks;
  while (tasks.length > TASKS_MINIMUM && size({ ...current, tasks, tasksNote: tasksNote(total, tasks.length, locale) }) > maxChars) {
    tasks = tasks.slice(0, -1);
  }
  if (tasks.length === current.tasks.length) return current;
  return { ...current, tasks, tasksNote: tasksNote(total, tasks.length, locale) };
}

