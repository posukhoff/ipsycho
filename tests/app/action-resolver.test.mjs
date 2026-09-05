import test from "node:test";
import assert from "node:assert/strict";
import { resolveActions } from "../../dist/actions/action-resolver.js";
import { buildRefMap } from "../../dist/core/ai-refs.js";
import { ResolvedActionSchema } from "../../dist/core/ai-contract.js";

/**
 * The resolver is the only place that turns `t1` into a UUID and decides whether an action
 * means one occurrence, the whole series or the task itself. The model never makes that
 * choice, so every branch here is a rule the user can hit by phrasing a sentence.
 */

const ONE_TIME = "aaaaaaaa-0000-4000-8000-000000000001";
const RECURRING = "aaaaaaaa-0000-4000-8000-000000000002";
const FUZZY = "aaaaaaaa-0000-4000-8000-000000000003";
const CLOSED = "aaaaaaaa-0000-4000-8000-000000000004";
const GOAL = "bbbbbbbb-0000-4000-8000-000000000001";
const MEMORY = "cccccccc-0000-4000-8000-000000000001";
const OCC_ONE_TIME = "dddddddd-0000-4000-8000-000000000001";
const OCC_RECURRING = "dddddddd-0000-4000-8000-000000000002";

const timezone = "Europe/Kyiv";

const TASKS = {
  t1: { id: ONE_TIME, version: 4, status: "active", timeMode: "point", timezone, recurrenceRule: null, title: "Позвонить клиенту", recurring: false },
  t2: { id: RECURRING, version: 7, status: "active", timeMode: "point", timezone, recurrenceRule: "FREQ=WEEKLY;BYDAY=TU", title: "Английский", recurring: true },
  t3: { id: FUZZY, version: 2, status: "active", timeMode: "fuzzy", timezone, recurrenceRule: null, title: "Забрать посылку", recurring: false },
  t4: { id: CLOSED, version: 9, status: "completed", timeMode: "point", timezone, recurrenceRule: null, title: "Старая задача", recurring: false },
};

const OCCURRENCES = {
  [ONE_TIME]: { id: OCC_ONE_TIME, version: 1, status: "scheduled", timezone },
  [RECURRING]: { id: OCC_RECURRING, version: 3, status: "open", timezone },
};

const SETTINGS = { version: 11, timezone, morningReferenceTime: "09:00" };

const refs = buildRefMap({
  tasks: Object.entries(TASKS).map(([shortId, task]) => ({
    shortId,
    id: task.id,
    version: task.version,
    title: task.title,
    timeMode: task.timeMode,
    recurring: task.recurring,
    status: task.status,
  })),
  goals: [{ shortId: "g1", id: GOAL, version: 2, title: "Запустить группу" }],
  memory: [{ shortId: "m1", id: MEMORY, version: 5, title: "Ложится в 23:30" }],
});

function makeDeps(overrides = {}) {
  const byId = new Map(Object.values(TASKS).map((task) => [task.id, task]));
  const calls = { occurrence: [] };
  const deps = {
    findTask: async (taskId) => {
      const task = byId.get(taskId);
      return task ? { id: task.id, version: task.version, status: task.status, timeMode: task.timeMode, timezone: task.timezone, recurrenceRule: task.recurrenceRule } : null;
    },
    findCurrentOccurrence: async (taskId, opts) => {
      calls.occurrence.push({ taskId, opts });
      return (overrides.occurrences ?? OCCURRENCES)[taskId] ?? null;
    },
    findGoal: async (goalId) => (goalId === GOAL ? { id: GOAL, version: 2, status: "active" } : null),
    findMemory: async (memoryId) => (memoryId === MEMORY ? { id: MEMORY, version: 5 } : null),
    findTaskGoalLink: async (taskId, goalId) => ((overrides.links ?? []).some(([task, goal]) => task === taskId && goal === goalId) ? { taskId, goalId } : null),
    settings: async () => overrides.settings ?? SETTINGS,
    ...overrides.deps,
  };
  return { deps, calls };
}

const setState = (over = {}) => ({ type: "set_task_state", intent: "explicit", task: { id: "t1" }, state: "done", note: null, scope: null, ...over });
const rescheduleTo = (over = {}) => ({
  type: "reschedule",
  intent: "explicit",
  task: { id: "t1" },
  when: { mode: "exact", date: "2026-09-10", time: "15:00", durationMinutes: null },
  reason: null,
  scope: null,
  recurrence: null,
  timezone: null,
  ...over,
});
const setReminder = (over = {}) => ({
  type: "set_reminder",
  intent: "explicit",
  task: { id: "t1" },
  mode: "add",
  reminder: { kind: "at", date: "2026-09-10", time: "09:00", quiet: "respect" },
  ...over,
});
const goalAction = (over = {}) => ({
  type: "goal",
  intent: "explicit",
  op: "link",
  goal: { id: "g1" },
  task: { id: "t1" },
  title: null,
  why: null,
  targetDate: null,
  status: null,
  reviewEnabled: null,
  ...over,
});
const emptyPatch = () => ({ title: null, why: null, nextAction: null, context: null, checklist: null, importance: null, habit: null });
const createTask = (over = {}) => ({
  type: "create_task",
  intent: "explicit",
  title: "Новая задача",
  why: null,
  nextAction: null,
  context: null,
  checklist: null,
  importance: "normal",
  kind: "task",
  when: { mode: "exact", date: "2026-09-10", time: "15:00", durationMinutes: null },
  recurrence: null,
  reminder: null,
  habit: null,
  timezone: null,
  goal: null,
  ...over,
});

async function resolve(actions, overrides = {}) {
  const { deps, calls } = makeDeps(overrides);
  const result = await resolveActions(actions, overrides.refs ?? refs, deps);
  return { ...result, calls };
}

const onlyIssue = (result) => {
  assert.equal(result.issues.length, 1, `expected exactly one issue, got ${JSON.stringify(result.issues)}`);
  return result.issues[0];
};

test("a short id the context never assigned is a reference error, not a guess", async () => {
  const result = await resolve([setState({ task: { id: "t9" } })]);
  assert.deepEqual(result.resolved, []);
  const issue = onlyIssue(result);
  assert.equal(issue.kind, "reference");
  assert.equal(issue.code, "ref_not_found");
  assert.equal(issue.index, 0);
});

test("a goal id where a task belongs is rejected instead of silently resolving the wrong entity", async () => {
  const result = await resolve([setState({ task: { id: "g1" } })]);
  const issue = onlyIssue(result);
  assert.equal(issue.kind, "reference");
  assert.equal(issue.code, "ref_kind_mismatch");

  const wrongGoal = await resolve([goalAction({ goal: { id: "t1" } })]);
  assert.equal(onlyIssue(wrongGoal).code, "ref_kind_mismatch");
});

test("a one-time task resolves to its current occurrence with the version read from the database", async () => {
  const result = await resolve([setState({ task: { id: "t1" }, state: "done" })]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.resolved[0].target, {
    kind: "occurrence",
    taskId: ONE_TIME,
    taskVersion: 4,
    occurrenceId: OCC_ONE_TIME,
    occurrenceVersion: 1,
    timezone,
  });
  // Completing may land on an occurrence whose time has already passed.
  assert.deepEqual(result.calls.occurrence[0].opts, { includeElapsed: true });
  assert.equal(ResolvedActionSchema.safeParse(result.resolved[0]).success, true);
});

test("scope=series on a recurring task targets the series, not one occurrence", async () => {
  const result = await resolve([setState({ task: { id: "t2" }, state: "cancelled", scope: "series" })]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.resolved[0].target, { kind: "series", taskId: RECURRING, taskVersion: 7 });
  assert.equal(result.calls.occurrence.length, 0, "a series target never needs the current occurrence");
});

test("cancelling a recurring task without a scope asks which one instead of choosing", async () => {
  const result = await resolve([setState({ task: { id: "t2" }, state: "cancelled", scope: null })]);
  assert.deepEqual(result.resolved, []);
  const issue = onlyIssue(result);
  assert.equal(issue.kind, "ambiguous");
  assert.equal(issue.code, "scope_required");
  assert.deepEqual(
    issue.candidates?.map((candidate) => candidate.id),
    ["occurrence", "series"],
  );
});

test("scope=occurrence on a recurring task resolves the current occurrence", async () => {
  const result = await resolve([setState({ task: { id: "t2" }, state: "cancelled", scope: "occurrence" })]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.resolved[0].target, {
    kind: "occurrence",
    taskId: RECURRING,
    taskVersion: 7,
    occurrenceId: OCC_RECURRING,
    occurrenceVersion: 3,
    timezone,
  });
});

test("a task without a date can be completed, cancelled or given a date — and nothing else", async () => {
  for (const state of ["done", "cancelled"]) {
    const result = await resolve([setState({ task: { id: "t3" }, state })]);
    assert.deepEqual(result.issues, [], state);
    assert.deepEqual(result.resolved[0].target, { kind: "task", taskId: FUZZY, taskVersion: 2 }, state);
  }
  for (const state of ["started", "seen", "skipped"]) {
    const result = await resolve([setState({ task: { id: "t3" }, state })]);
    assert.equal(onlyIssue(result).code, "fuzzy_no_occurrence", state);
    assert.equal(result.issues[0].kind, "domain", state);
  }

  const reminder = await resolve([setReminder({ task: { id: "t3" } })]);
  assert.equal(onlyIssue(reminder).code, "fuzzy_reminder");

  const moved = await resolve([rescheduleTo({ task: { id: "t3" } })]);
  assert.deepEqual(moved.issues, []);
  assert.deepEqual(moved.resolved[0].target, { kind: "task", taskId: FUZZY, taskVersion: 2 });
});

test("a closed task is never reopened by a chat action", async () => {
  const result = await resolve([setState({ task: { id: "t4" }, state: "done" })]);
  assert.equal(onlyIssue(result).code, "task_not_active");
});

test("a one-time task cannot be skipped and has no series to change", async () => {
  const skipped = await resolve([setState({ task: { id: "t1" }, state: "skipped" })]);
  assert.equal(onlyIssue(skipped).code, "skip_one_time");

  const rescheduled = await resolve([rescheduleTo({ task: { id: "t1" }, scope: "series" })]);
  assert.equal(onlyIssue(rescheduled).code, "not_recurring");
});

test("cancelling a one-time task with scope=series cancels the task instead of refusing", async () => {
  // A task that does not repeat has one occurrence, so «всю серию» and «это» name the same thing.
  // Refusing here broke merging two tasks: the absorbed one is cancelled, and the model called it
  // a series.
  const result = await resolve([setState({ task: { id: "t1" }, state: "cancelled", scope: "series" })]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.resolved[0].target, { kind: "task", taskId: ONE_TIME, taskVersion: TASKS.t1.version });
});

test("the same action twice in one message is applied once and reported", async () => {
  const result = await resolve([setState({ task: { id: "t1" }, state: "done" }), setState({ task: { id: "t1" }, state: "done" })]);
  assert.equal(result.resolved.length, 1);
  const issue = onlyIssue(result);
  assert.equal(issue.code, "duplicate_action");
  assert.equal(issue.index, 1);
});

test("linking what is already linked and unlinking what is not are both refused with the true reason", async () => {
  const already = await resolve([goalAction({ op: "link" })], { links: [[ONE_TIME, GOAL]] });
  assert.equal(onlyIssue(already).code, "already_linked");

  const notLinked = await resolve([goalAction({ op: "unlink" })], { links: [] });
  assert.equal(onlyIssue(notLinked).code, "not_linked");

  const linked = await resolve([goalAction({ op: "link" })], { links: [] });
  assert.deepEqual(linked.issues, []);
  assert.deepEqual(
    { goalId: linked.resolved[0].goalId, goalVersion: linked.resolved[0].goalVersion, taskId: linked.resolved[0].taskId, taskVersion: linked.resolved[0].taskVersion },
    { goalId: GOAL, goalVersion: 2, taskId: ONE_TIME, taskVersion: 4 },
  );
});

test("a settings action carries the version the server just read, never one the model supplied", async () => {
  const action = {
    type: "settings",
    intent: "explicit",
    operation: "quiet_hours",
    timezone: null,
    applyTimezoneTo: null,
    language: null,
    digestKind: null,
    enabled: true,
    time: null,
    weekday: null,
    weekdayStart: "22:00",
    weekdayEnd: "08:00",
    weekendStart: null,
    weekendEnd: null,
    snoozeUntilDate: null,
    snoozeUntilTime: null,
    eventOffsets: null,
    plannedTaskOffsetMinutes: null,
    criticalPostDueMinutes: null,
    seenNormalMinutes: null,
    seenRequiredMinutes: null,
    seenCriticalMinutes: null,
  };
  const result = await resolve([action]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.resolved[0].expectedVersion, 11);
  assert.equal(result.resolved[0].timezone, timezone);
  assert.equal(ResolvedActionSchema.safeParse(result.resolved[0]).success, true);
});

test("a zone the user named is honoured and a made-up one is refused before anything is written", async () => {
  const named = await resolve([createTask({ timezone: "America/New_York" })]);
  assert.deepEqual(named.issues, []);
  assert.equal(named.resolved[0].timezone, "America/New_York");
  assert.equal(named.resolved[0].body.timezone, null, "the zone lives on the action, not twice in the body");
  assert.equal(named.resolved[0].reviewTime, "09:00");

  const invalid = await resolve([createTask({ timezone: "Moon/Base" })]);
  const issue = onlyIssue(invalid);
  assert.equal(issue.kind, "domain");
  assert.equal(issue.code, "timezone");

  const inherited = await resolve([createTask({ timezone: null })]);
  assert.equal(inherited.resolved[0].timezone, timezone);
});

test("a package keeps resolving after one action fails, and every issue names its own index", async () => {
  const result = await resolve([
    setState({ task: { id: "t9" }, state: "done" }),
    setState({ task: { id: "t1" }, state: "done" }),
    setState({ task: { id: "t1" }, state: "skipped" }),
  ]);
  assert.equal(result.resolved.length, 1);
  assert.deepEqual(
    result.issues.map((issue) => [issue.index, issue.code]),
    [
      [0, "ref_not_found"],
      [2, "skip_one_time"],
    ],
  );
});

test("an explanation attached to a cancellation is dropped, not fatal", async () => {
  // The model narrates why it cancels («объединено с t1»); a note only has a home with `seen`,
  // and rejecting the package over that sentence used to kill an otherwise correct merge.
  const result = await resolve([setState({ task: { id: "t1" }, state: "cancelled", note: "Объединено с задачей t2" })]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.resolved[0].note, null);

  const blocker = await resolve([setState({ task: { id: "t1" }, state: "seen", note: "жду ответа от банка" })]);
  assert.deepEqual(blocker.issues, []);
  assert.equal(blocker.resolved[0].note, "жду ответа от банка");
});

test("an update that changes nothing is dropped when the message carries other work", async () => {
  // «выдели X в отдельную задачу» sometimes comes back as a create plus an update with an empty
  // patch. Failing the package over that threw away the task the user actually asked for.
  const withCreate = await resolve([{ type: "update_task", intent: "explicit", task: { id: "t1" }, patch: emptyPatch() }, createTask({ title: "Устранить течь у биде" })]);
  assert.deepEqual(withCreate.issues, []);
  assert.equal(withCreate.resolved.length, 1);
  assert.equal(withCreate.resolved[0].type, "create_task");

  // Alone it is kept, so the domain validation still refuses it and the reply never claims a
  // change that did not happen (see the empty_patch test in action-conversion).
  const alone = await resolve([{ type: "update_task", intent: "explicit", task: { id: "t1" }, patch: emptyPatch() }]);
  assert.deepEqual(alone.issues, []);
  assert.equal(alone.resolved.length, 1);
  assert.equal(alone.resolved[0].type, "update_task");
});
