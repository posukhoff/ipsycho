import assert from "node:assert/strict";
import test from "node:test";
import { ENDPOINTS } from "../../dist/api/contracts/index.js";
import { scopeMatches } from "../../dist/core/task-list-view.js";
import { answer } from "../../web/src/mocks/answers.ts";
import * as fixtures from "../../web/src/mocks/fixtures.ts";

/**
 * The Mini App's mock backend, held to the contract it claims to implement.
 *
 * `web/src/mocks/` is what groups 5–8 built every screen against, weeks before any of them met a
 * real endpoint, and nothing ran it: `check:web` only ran the dictionary test, and the four lies
 * review round 2 found in it were found by reading. A screen written against a mock that answers
 * with an `undoGroupId` the server would not send grows an Undo snackbar with nothing to undo, and
 * that is not a defect anyone sees until production.
 *
 * It runs here rather than under `check:web` because `ENDPOINTS` is server code: `npm run test:app`
 * builds `dist/` first, and this is the only place where the compiled contract and the browser's
 * fixtures are both loadable by Node. `answer` is imported straight from TypeScript — Node 24
 * strips the types — which is why `web/src/mocks/answers.ts` holds no runtime import but the
 * fixtures.
 */

test("every mock answer parses against its endpoint's response schema", () => {
  for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
    const result = endpoint.response.safeParse(answer(name, {}));
    assert.ok(result.success, `${name}: ${result.success ? "" : JSON.stringify(result.error.issues.slice(0, 3))}`);
  }
});

/**
 * Undo is offered exactly where the server journals the change. Each row is a rule the server
 * applies, and the mock has to answer the same way or the screen is built against the wrong one.
 */
const UNDO_EXPECTATIONS = [
  // `set_task_state` journals done, skipped and cancelled; `started` and `seen` have no action to
  // roll back, so `WebTasksService` writes them straight through `TasksService`.
  { name: "setTaskState", request: { body: { state: "done" } }, undo: true },
  { name: "setTaskState", request: { body: { state: "skipped" } }, undo: true },
  { name: "setTaskState", request: { body: { state: "cancelled" } }, undo: true },
  { name: "setTaskState", request: { body: { state: "started" } }, undo: false },
  { name: "setTaskState", request: { body: { state: "seen" } }, undo: false },
  // Resume materialises dates outside the journal: undoing it would restore the paused parent and
  // leave those dates live and reminding.
  { name: "pauseSeries", request: {}, undo: true },
  { name: "resumeSeries", request: {}, undo: false },
  // A snooze creates a contact and changes no state; a repeat is a journalled `set_reminder`.
  { name: "snoozeReminder", request: { body: { choice: "1h" } }, undo: false },
  { name: "repeatReminder", request: { body: { date: "2026-09-06", time: "10:00" } }, undo: true },
  // `update_memory` and `forget_memory` both journal the row's before-state.
  { name: "patchMemory", request: { body: { text: "x" } }, undo: true },
  { name: "deleteMemory", request: {}, undo: true },
  // The two settings writes that skip the journal: «до утра», and a timezone change that also
  // copies the zone onto the digest or quiet-hours columns, which would otherwise undo by halves.
  { name: "patchSettings", request: { body: { change: { operation: "snooze", until: { kind: "morning" } } } }, undo: false },
  { name: "patchSettings", request: { body: { change: { operation: "timezone", applyTo: "digests" } } }, undo: false },
  { name: "patchSettings", request: { body: { change: { operation: "timezone", applyTo: "both" } } }, undo: true },
  { name: "patchSettings", request: { body: { change: { operation: "language", language: "uk" } } }, undo: true },
  { name: "takeToday", request: {}, undo: true },
];

test("the mock offers Undo exactly where the server journals the change", () => {
  for (const { name, request, undo } of UNDO_EXPECTATIONS) {
    const body = answer(name, request);
    const label = `${name} ${JSON.stringify(request.body ?? {})}`;
    assert.ok("undoGroupId" in body, `${label} carries no undoGroupId`);
    assert.equal(body.undoGroupId !== null, undo, `${label} should ${undo ? "offer" : "withhold"} Undo`);
  }
});

test("no other mock answer claims an undo group", () => {
  const covered = new Set(UNDO_EXPECTATIONS.map((row) => row.name));
  for (const name of Object.keys(ENDPOINTS)) {
    if (covered.has(name)) continue;
    const body = answer(name, {});
    if (body && typeof body === "object" && "undoGroupId" in body) {
      // A write that reaches `ActionsService` and journals: the group is truthful. Listing them
      // here rather than asserting `null` keeps the failure loud when a new endpoint appears.
      assert.ok(
        ["createTask", "updateTask", "reschedule", "checklist", "createGoal", "updateGoal", "linkGoal", "unlinkGoal"].includes(name),
        `${name} answers with an undo group and no rule says why`,
      );
      assert.notEqual(body.undoGroupId, null, `${name} journals, so the mock must offer Undo`);
    }
  }
});

/**
 * `listTodayGrouped` keeps only the rows whose occurrence covers the requested day, then groups
 * them. So a Today group holds two rows when a series fires twice in one day — never because the
 * series' next date exists. The fixture said otherwise and taught the screen a shape the server
 * cannot send.
 */
test("every row in the today fixture is on the day the fixture is for", () => {
  for (const group of fixtures.today.groups) {
    for (const row of group.rows) {
      assert.equal(row.localDate ?? fixtures.today.localDate, fixtures.today.localDate, `${group.title}: a row dated ${row.localDate} cannot be in today's groups`);
    }
  }
});

/**
 * The scope tabs, checked against the rule the server filters by rather than against a reading of
 * it. `scopeMatches` keeps anything already past in every window, drops an undated task from all of
 * them but `nodate`, and `today` is `week` with a zero-day horizon — which is how `today` was found
 * holding the standup series' *next* date and `month` an undated one.
 */
const SCOPES = ["overdue", "today", "week", "month", "all", "nodate"];

/** The contract row as the domain rule reads it: `scopeMatches` wants a task and an occurrence. */
function asDomainRow(row) {
  return {
    task: { id: row.taskId, title: row.title, importance: row.importance, timezone: row.timezone, reviewAt: row.fuzzy?.reviewAt ?? null },
    occurrence: row.schedule ? { id: row.occurrenceId, overdue: row.overdue, ...row.schedule } : null,
  };
}

test("every row the mock puts in a scope belongs to it", () => {
  for (const scope of SCOPES) {
    const response = fixtures.taskListForScope(scope);
    assert.equal(response.scope, scope, `the mock has no bucket for ${scope} and fell back to another`);
    for (const group of response.groups) {
      for (const row of group.rows) {
        assert.ok(scopeMatches(asDomainRow(row), scope, response.todayLocalDate), `${scope}: «${row.title}» dated ${row.localDate} does not match the scope`);
      }
    }
    assert.equal(response.counts[scope], response.groups.length, `${scope}: the tab badge does not count the groups the same tab returns`);
  }
});
