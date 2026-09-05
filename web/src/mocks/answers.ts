import * as fixtures from "./fixtures.ts";
import type { EndpointName } from "../api/contracts.js";

/**
 * What the mock backend answers, per endpoint — the fixtures only, with no schema in sight.
 *
 * It is split from `index.ts` so that `tests/app/webapp-mocks.test.mjs` can import it under Node.
 * `index.ts` imports `ENDPOINTS` at run time, and that reaches `src/api/contracts/**`, whose
 * `.js` specifiers only resolve under Vite; everything here is either a value from `./fixtures.ts`
 * or a type, and Node strips the types away. Hence the `.ts` extension on that one import: it is
 * what makes the same file readable by Vite and by `node --test` without a second build step.
 *
 * Keeping it honest is the point of that test. A mock that answers with an `undoGroupId` the server
 * would not send builds the Undo snackbar into a screen with nothing to undo, and the screens are
 * written against this file weeks before they meet the real endpoint.
 */

export interface MockRequest {
  params?: Readonly<Record<string, string>> | undefined;
  query?: unknown;
  body?: unknown;
}

function fail(name: EndpointName): never {
  throw new Error(`no mock fixture for endpoint ${name}`);
}

export interface MockRequest {
  params?: Readonly<Record<string, string>> | undefined;
  query?: unknown;
  body?: unknown;
}

/** Writes answer with the object as it would stand after the change, not with a fresh read. */
export function answer(name: EndpointName, request: MockRequest): unknown {
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
      return { undoGroupId: null };
    case "repeatReminder":
      return { undoGroupId: fixtures.undoGroupId };
    case "cancelReminder":
      return { cancelled: true };

    case "settings":
      return fixtures.settings;
    case "patchSettings": {
      // Two settings writes skip the journal, so the server answers them with no group: «отложить
      // до утра» goes through `SettingsService` directly, and a timezone change that also copies
      // the zone onto the digest or quiet-hours columns would otherwise undo by halves. A mock that
      // always handed a group back would put an Undo snackbar on both.
      const change = (request.body as { change?: { operation?: string; until?: { kind?: string }; applyTo?: string } } | undefined)?.change;
      const unjournalled =
        (change?.operation === "snooze" && change.until?.kind === "morning") || (change?.operation === "timezone" && (change.applyTo === "digests" || change.applyTo === "quiet"));
      return { settings: fixtures.settings, undoGroupId: unjournalled ? null : fixtures.undoGroupId };
    }
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
