import { ENDPOINTS, type EndpointName } from "../api/contracts.js";
import * as fixtures from "./fixtures.js";

/**
 * The mock backend, reached only when `VITE_API_MOCK=1`.
 *
 * `npm -w @ipsycho/web run dev` with the flag set renders every screen with no Postgres, no bot
 * token and no `initData` — which is what lets groups 5–8 start the moment this file exists instead
 * of waiting for groups 1–4.
 *
 * Every answer is parsed against the endpoint's own response schema before it is returned. That
 * turns a drifted fixture into a loud failure in the client the frontend agent is already looking
 * at, rather than a screen that renders happily against a shape the server will never send.
 */

const LATENCY_MS = 120;

function fail(name: EndpointName): never {
  throw new Error(`no mock fixture for endpoint ${name}`);
}

export interface MockRequest {
  params?: Readonly<Record<string, string>> | undefined;
  query?: unknown;
  body?: unknown;
}

/** Writes answer with the object as it would stand after the change, not with a fresh read. */
function answer(name: EndpointName, request: MockRequest): unknown {
  switch (name) {
    case "me":
      return fixtures.me;

    case "taskList": {
      // The scope tabs are the one place a mock that ignores the query is actively misleading:
      // `nodate` holds the fuzzy task, and `overdue` holds only the row whose day has passed.
      const scope = (request.query as { scope?: string } | undefined)?.scope ?? "week";
      return fixtures.taskListForScope(scope);
    }
    case "today":
      return fixtures.today;
    case "pausedSeries":
      return fixtures.pausedSeries;
    case "task":
      return fixtures.taskDetail;
    case "rescheduleOptions":
      return fixtures.rescheduleOptions;
    case "createTask":
    case "updateTask":
    case "reschedule":
    case "checklist":
    case "pauseSeries":
      return { task: fixtures.taskDetail, undoGroupId: fixtures.undoGroupId };
    case "setTaskState": {
      // `started` and `seen` have no `set_task_state` to journal, so the server answers with no
      // group. A mock that handed one back would build the Undo snackbar into a screen that has
      // nothing to undo — the fixture is the contract the screens are written against.
      const state = (request.body as { state?: string } | undefined)?.state;
      const acknowledgement = state === "started" || state === "seen";
      return { task: fixtures.taskDetail, undoGroupId: acknowledgement ? null : fixtures.undoGroupId };
    }
    case "resumeSeries":
      // Resume materialises dates outside the journal: undoing it would restore the paused parent
      // and leave those dates live and reminding. The server answers `null`, and so does this.
      return { task: fixtures.taskDetail, undoGroupId: null };
    case "undo":
      return { undone: true };

    case "goals":
      return fixtures.goals;
    case "goal":
      return fixtures.goalDetail;
    case "createGoal":
    case "updateGoal":
    case "linkGoal":
    case "unlinkGoal":
      return { goal: fixtures.goalDetail, undoGroupId: fixtures.undoGroupId };

    case "reminders":
      return fixtures.reminders;
    case "snoozeReminder":
      // A snooze creates a contact and changes no state, so there is nothing for Undo to restore.
      return { reminder: fixtures.reminders.rows[0] ?? null, undoGroupId: null };
    case "repeatReminder":
      return { reminder: fixtures.reminders.rows[0] ?? null, undoGroupId: fixtures.undoGroupId };
    case "cancelReminder":
      return { cancelled: true };

    case "settings":
      return fixtures.settings;
    case "patchSettings":
      return { settings: fixtures.settings, undoGroupId: fixtures.undoGroupId };
    case "timezoneSearch":
      return fixtures.timezoneSearch;

    case "memory":
      return fixtures.memory;
    case "patchMemory":
      // `update_memory` is journalled and the row's before-state is what Undo restores; the server
      // answers with the group, so a screen built against a `null` here would hide a live feature.
      return { item: fixtures.memory.rows[0] ?? null, undoGroupId: fixtures.undoGroupId };
    case "deleteMemory":
      return { item: null, undoGroupId: fixtures.undoGroupId };
    case "profile":
      return fixtures.profile;
    case "clearHistory":
      return { cleared: fixtures.settings.historyMessageCount };

    case "consents":
    case "grantConsent":
    case "revokeConsent":
      return fixtures.consents;
    case "deleteAccount":
      return { deleteAfter: "2026-09-19T00:00:00.000Z", graceDays: 14, restoreIsChatOnly: true };

    case "week":
      return fixtures.week;
    case "pickWeek":
      return { result: "picked", targetWeekStart: fixtures.WEEK_START, pickedCount: 2, row: fixtures.week.rows[2] ?? null };
    case "releaseWeek":
      return { result: "released", targetWeekStart: fixtures.WEEK_START, pickedCount: 0, row: fixtures.week.rows[0] ?? null };
    case "takeToday":
      return { taskId: fixtures.taskIds.bookTask, occurrenceId: fixtures.taskIds.callOccurrence, localDate: fixtures.TODAY, undoGroupId: fixtures.undoGroupId };

    default:
      return fail(name);
  }
}

export async function mockRequest(name: EndpointName, request: MockRequest = {}): Promise<unknown> {
  // A little latency on purpose: a screen that only ever saw an instant answer has no loading state.
  await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
  return ENDPOINTS[name].response.parse(answer(name, request));
}

/** Parses every fixture once. A test — or a developer opening the app — sees a drift immediately. */
export function validateAllFixtures(): void {
  for (const name of Object.keys(ENDPOINTS) as EndpointName[]) ENDPOINTS[name].response.parse(answer(name, {}));
}
