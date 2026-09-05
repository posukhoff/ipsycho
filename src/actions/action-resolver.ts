import { MAX_TURN_ACTIONS, type AiAction, type Reminder, type ResolvedAction, type TaskTarget, type When } from "../core/ai-contract.js";
import type { ActionIssue } from "../core/ai-actions.js";
import { refKindOf, type RefMap } from "../core/ai-refs.js";
import type { OccurrenceStatus, TaskStatus, TimeMode } from "../core/types.js";
import { assertTimezone, InvalidAiActionError, isNoOpUpdatePatch } from "./action-conversion.js";
import { localDateAt, localDateTimeAt } from "../core/timezone.js";

/**
 * Turns the model's short-id actions into server-resolved ones. Versions and the current
 * occurrence are re-read here, never taken from the map: the map may be minutes old and a
 * button could have moved the task meanwhile. Nothing here writes.
 */
export interface ResolverDeps {
  findTask(taskId: string): Promise<{ id: string; version: number; status: TaskStatus; timeMode: TimeMode; timezone: string; recurrenceRule: string | null } | null>;
  findCurrentOccurrence(taskId: string, opts: { includeElapsed: boolean }): Promise<{ id: string; version: number; status: OccurrenceStatus; timezone: string } | null>;
  findGoal(goalId: string): Promise<{ id: string; version: number; status: string } | null>;
  findMemory(memoryId: string): Promise<{ id: string; version: number } | null>;
  findTaskGoalLink(taskId: string, goalId: string): Promise<unknown | null>;
  settings(): Promise<{ version: number; timezone: string; morningReferenceTime: string }>;
}

export interface ResolveResult {
  resolved: ResolvedAction[];
  issues: ActionIssue[];
}

class ResolveError extends Error {
  constructor(readonly issue: Omit<ActionIssue, "index">) {
    super(issue.message);
  }
}

const domain = (code: string, message: string): ResolveError => new ResolveError({ kind: "domain", code, message });
const reference = (code: string, message: string): ResolveError => new ResolveError({ kind: "reference", code, message });

export async function resolveActions(actions: readonly AiAction[], refs: RefMap, deps: ResolverDeps, now: Date = new Date()): Promise<ResolveResult> {
  if (actions.length > MAX_TURN_ACTIONS) {
    return { resolved: [], issues: [{ index: 0, kind: "domain", code: "too_many_actions", message: `one message applies at most ${MAX_TURN_ACTIONS} actions` }] };
  }
  const settings = await deps.settings();
  const resolved: ResolvedAction[] = [];
  const issues: ActionIssue[] = [];
  const seen = new Set<string>();
  // An update that changes nothing is dropped when the message carries other work: the model
  // sometimes pairs «выдели X в отдельную задачу» with an empty patch, and failing the package
  // over it threw away the new task the user actually asked for. Alone, it still reports.
  const meaningful = actions.filter((action) => action.type !== "update_task" || !isNoOpUpdatePatch(action.patch));
  const effective = meaningful.length && meaningful.length < actions.length ? meaningful : actions;
  for (const [index, action] of effective.entries()) {
    try {
      const timezone = timezoneFor(action, settings.timezone);
      const base = { intent: action.intent, timezone, reviewTime: reviewTimeFor(action, timezone, settings.morningReferenceTime, now) };
      const item = await resolveOne(action, base, refs, deps, settings.version);
      const key = identity(item);
      if (seen.has(key)) throw domain("duplicate_action", "the same action is repeated in one message");
      seen.add(key);
      resolved.push(item);
    } catch (error) {
      if (error instanceof ResolveError) issues.push({ index, ...error.issue });
      else if (error instanceof InvalidAiActionError) issues.push({ index, kind: "domain", code: error.code, message: error.message });
      else throw error;
    }
  }
  return { resolved, issues };
}

/**
 * The planning checkpoint of a fuzzy task is the user's morning reference time, but that
 * moment may already be gone today: the server picks the time, so it must not pick one in
 * the past and blame the user for it.
 */
function reviewTimeFor(action: AiAction, timezone: string, morningReferenceTime: string, now: Date): string {
  const when = action.type === "create_task" ? action.when : action.type === "reschedule" ? action.when : null;
  const dates =
    when?.mode === "fuzzy"
      ? [when.reviewDate]
      : action.type === "plan"
        ? action.tasks.filter((task) => task.when.mode === "fuzzy").map((task) => (task.when as { reviewDate: string }).reviewDate)
        : [];
  if (!dates.includes(localDateAt(now, timezone))) return morningReferenceTime;
  const parts = localDateTimeAt(now, timezone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const [refHour = 9, refMinute = 0] = morningReferenceTime.split(":").map(Number);
  if (refHour * 60 + refMinute > nowMinutes) return morningReferenceTime;
  const soon = Math.ceil((nowMinutes + 60) / 15) * 15;
  if (soon >= 24 * 60) return morningReferenceTime;
  return `${String(Math.floor(soon / 60)).padStart(2, "0")}:${String(soon % 60).padStart(2, "0")}`;
}

function timezoneFor(action: AiAction, fallback: string): string {
  const named = action.type === "create_task" || action.type === "reschedule" ? action.timezone : null;
  if (!named) return fallback;
  assertTimezone(named);
  return named;
}

async function resolveOne(
  action: AiAction,
  base: { intent: AiAction["intent"]; timezone: string; reviewTime: string },
  refs: RefMap,
  deps: ResolverDeps,
  settingsVersion: number,
): Promise<ResolvedAction> {
  switch (action.type) {
    case "create_task": {
      const { type: _type, intent: _intent, goal, timezone: _timezone, ...body } = action;
      return { type: "create_task", ...base, body: { ...body, timezone: null }, goal: goal ? await goalRef(goal.id, refs, deps) : null };
    }
    case "plan":
      return { type: "plan", ...base, goal: action.goal, tasks: action.tasks.map((task) => ({ ...task, timezone: null })) };
    case "update_task": {
      const task = await taskRef(action.task.id, refs, deps);
      return { type: "update_task", ...base, taskId: task.id, taskVersion: task.version, patch: action.patch };
    }
    case "set_task_state": {
      const task = await taskRef(action.task.id, refs, deps);
      const target = await taskTarget(task, action.scope, deps, { includeElapsed: action.state === "done", purpose: "state", state: action.state });
      return { type: "set_task_state", ...base, target, state: action.state };
    }
    case "reschedule": {
      const task = await taskRef(action.task.id, refs, deps);
      const target = await taskTarget(task, action.scope, deps, { includeElapsed: false, purpose: "reschedule", when: action.when });
      if (action.recurrence && target.kind !== "series") throw domain("recurrence_scope", "recurrence can only change with scope=series");
      return { type: "reschedule", ...base, target, when: action.when, recurrence: action.recurrence, reason: action.reason };
    }
    case "set_reminder": {
      const task = await taskRef(action.task.id, refs, deps);
      if (action.mode === "clear" && action.reminder !== null) throw domain("reminder_shape", "clear reminder requires reminder=null");
      if (action.mode !== "clear" && !action.reminder) throw domain("reminder_shape", "reminder is required");
      const target = await taskTarget(task, null, deps, { includeElapsed: false, purpose: "reminder", ...(action.reminder ? { reminder: action.reminder } : {}) });
      return { type: "set_reminder", ...base, target, mode: action.mode, reminder: action.reminder };
    }
    case "goal": {
      const empty = { goalId: null, goalVersion: null, taskId: null, taskVersion: null, title: null, why: null, targetDate: null, status: null };
      if (action.op === "create") {
        if (!action.title?.trim()) throw domain("goal_title", "goal title is required");
        return { type: "goal", ...base, op: "create", ...empty, title: action.title.trim(), why: action.why, targetDate: action.targetDate };
      }
      if (!action.goal) throw reference("ref_required", "goal reference is required");
      const goal = await goalRef(action.goal.id, refs, deps);
      if (action.op === "update") {
        if (action.title === null && action.why === null && action.targetDate === null && action.status === null) {
          throw domain("empty_patch", "update_goal patch must change at least one field");
        }
        return {
          type: "goal",
          ...base,
          op: "update",
          ...empty,
          goalId: goal.goalId,
          goalVersion: goal.goalVersion,
          title: action.title,
          why: action.why,
          targetDate: action.targetDate,
          status: action.status,
        };
      }
      if (!action.task) throw reference("ref_required", "task reference is required");
      const task = await taskRef(action.task.id, refs, deps);
      const linked = await deps.findTaskGoalLink(task.id, goal.goalId);
      if (action.op === "link" && linked) throw domain("already_linked", "task is already linked to this goal");
      if (action.op === "unlink" && !linked) throw domain("not_linked", "task is not linked to this goal");
      return { type: "goal", ...base, op: action.op, ...empty, goalId: goal.goalId, goalVersion: goal.goalVersion, taskId: task.id, taskVersion: task.version };
    }
    case "memory": {
      if (action.op === "save") {
        if (!action.kind) throw domain("memory_shape", "memory kind is required");
        if (!action.content?.trim()) throw domain("memory_shape", "memory content is required");
        return {
          type: "memory",
          ...base,
          op: "save",
          memoryId: null,
          memoryVersion: null,
          kind: action.kind,
          content: action.content.trim(),
          sensitive: action.sensitive ?? false,
        };
      }
      if (!action.item) throw reference("ref_required", "memory reference is required");
      const memory = await memoryRef(action.item.id, refs, deps);
      if (action.op === "update" && action.content === null && action.sensitive === null) throw domain("empty_patch", "update_memory patch must change at least one field");
      if (action.op === "update" && action.content !== null && !action.content.trim()) throw domain("blank_field", "memory content cannot be blank");
      return {
        type: "memory",
        ...base,
        op: action.op,
        memoryId: memory.id,
        memoryVersion: memory.version,
        kind: action.kind,
        content: action.content,
        sensitive: action.sensitive,
      };
    }
    case "settings": {
      const { type: _type, intent: _intent, timezone: namedTimezone, ...fields } = action;
      // `timezone` is both a settings field (the zone being set) and the action's own zone;
      // the resolved shape keeps the user's current zone and the field value separately.
      return { type: "settings", ...fields, ...base, timezone: namedTimezone ?? base.timezone, expectedVersion: settingsVersion };
    }
  }
}

async function taskRef(shortId: string, refs: RefMap, deps: ResolverDeps): Promise<NonNullable<Awaited<ReturnType<ResolverDeps["findTask"]>>>> {
  if (refKindOf(shortId) !== "tasks") throw reference("ref_kind_mismatch", `${shortId} is not a task id`);
  const entry = refs.tasks.get(shortId);
  if (!entry) throw reference("ref_not_found", `task ${shortId} is not in the current context`);
  const task = await deps.findTask(entry.id);
  if (!task) throw reference("stale", "target task is missing or stale");
  return task;
}

async function goalRef(shortId: string, refs: RefMap, deps: ResolverDeps): Promise<{ goalId: string; goalVersion: number }> {
  if (refKindOf(shortId) !== "goals") throw reference("ref_kind_mismatch", `${shortId} is not a goal id`);
  const entry = refs.goals.get(shortId);
  if (!entry) throw reference("ref_not_found", `goal ${shortId} is not in the current context`);
  const goal = await deps.findGoal(entry.id);
  if (!goal) throw reference("stale", "goal is missing or stale");
  return { goalId: goal.id, goalVersion: goal.version };
}

async function memoryRef(shortId: string, refs: RefMap, deps: ResolverDeps): Promise<{ id: string; version: number }> {
  if (refKindOf(shortId) !== "memory") throw reference("ref_kind_mismatch", `${shortId} is not a memory id`);
  const entry = refs.memory.get(shortId);
  if (!entry) throw reference("ref_not_found", `memory ${shortId} is not in the current context`);
  const memory = await deps.findMemory(entry.id);
  if (!memory) throw reference("stale", "memory is missing or stale");
  return memory;
}

type TaskRow = NonNullable<Awaited<ReturnType<ResolverDeps["findTask"]>>>;

/**
 * Which part of a task an action means. The model names only the task; the data model
 * decides between its current occurrence, the whole series, or the task itself (fuzzy).
 */
async function taskTarget(
  task: TaskRow,
  scope: "occurrence" | "series" | null,
  deps: ResolverDeps,
  opts: { includeElapsed: boolean; purpose: "state" | "reschedule" | "reminder"; state?: string; when?: When; reminder?: Reminder },
): Promise<TaskTarget> {
  const recurring = Boolean(task.recurrenceRule);
  if (task.status !== "active" && !(task.status === "paused" && recurring && scope === "series")) {
    throw domain("task_not_active", "task is already closed or cancelled");
  }
  const series = { kind: "series" as const, taskId: task.id, taskVersion: task.version };
  const whole = { kind: "task" as const, taskId: task.id, taskVersion: task.version };

  if (task.timeMode === "fuzzy") {
    // A task with no day can still carry a reminder of its own — it just has to name its own
    // moment. "15 minutes before" has nothing to count from, and inventing a day for it would be
    // the server deciding when the task happens.
    if (opts.purpose === "reminder" && opts.reminder && opts.reminder.kind !== "at") {
      throw domain("fuzzy_reminder_relative", "a task without a date cannot carry a reminder relative to its start");
    }
    if (opts.purpose === "state" && opts.state !== "done" && opts.state !== "cancelled") {
      throw domain("fuzzy_no_occurrence", "a task without a date can only be completed, cancelled or given a date");
    }
    return whole;
  }

  if (recurring) {
    if (opts.purpose === "state" && opts.state === "cancelled" && scope === null) {
      throw new ResolveError({
        kind: "ambiguous",
        code: "scope_required",
        message: "cancel one occurrence or the whole series?",
        candidates: [
          { id: "occurrence", title: "только это повторение" },
          { id: "series", title: "всю серию" },
        ],
      });
    }
    if (scope === "series") {
      if (opts.purpose === "state" && opts.state !== "cancelled") throw domain("series_state_unsupported", "a series can only be cancelled or rescheduled as a whole");
      if (opts.purpose === "reschedule" && opts.when?.mode === "fuzzy") throw domain("recurring_fuzzy", "recurring item cannot use fuzzy time");
      return series;
    }
  } else {
    // A task that does not repeat has exactly one occurrence, so "the whole series" and "this one"
    // name the same thing. Cancelling it is what the user asked for either way; refusing here made
    // «объедини эти две задачи» fail, because the model reasonably called the absorbed one a series.
    if (scope === "series" && opts.purpose === "state" && opts.state === "cancelled") return whole;
    if (scope === "series") throw domain("not_recurring", "task is not a recurring series");
    if (opts.purpose === "state" && opts.state === "skipped") throw domain("skip_one_time", "a one-time task cannot be skipped; cancel it instead");
  }
  if (opts.purpose === "reschedule" && recurring && opts.when?.mode === "fuzzy") throw domain("recurring_fuzzy", "one occurrence of a recurring series cannot become fuzzy");

  const occurrence = await deps.findCurrentOccurrence(task.id, { includeElapsed: opts.includeElapsed });
  if (!occurrence) {
    if (opts.purpose === "state" && (opts.state === "done" || opts.state === "cancelled")) return whole;
    throw domain("no_current_occurrence", "the task has no current occurrence to change");
  }
  return { kind: "occurrence", taskId: task.id, taskVersion: task.version, occurrenceId: occurrence.id, occurrenceVersion: occurrence.version, timezone: occurrence.timezone };
}

function identity(action: ResolvedAction): string {
  switch (action.type) {
    case "create_task":
      return `create:${action.body.title.trim().toLocaleLowerCase()}:${JSON.stringify(action.body.when)}`;
    case "plan":
      return `plan:${action.goal.title.trim().toLocaleLowerCase()}`;
    case "update_task":
      return `update:${action.taskId}`;
    case "set_task_state":
      return `state:${action.target.taskId}:${action.state}`;
    case "reschedule":
      return `reschedule:${action.target.taskId}:${action.target.kind}`;
    case "set_reminder":
      return `reminder:${action.target.taskId}:${action.mode}`;
    case "goal":
      return `goal:${action.op}:${action.goalId ?? action.title ?? ""}:${action.taskId ?? ""}`;
    case "memory":
      return `memory:${action.op}:${action.memoryId ?? action.content ?? ""}`;
    case "settings":
      return `settings:${action.operation}`;
  }
}
