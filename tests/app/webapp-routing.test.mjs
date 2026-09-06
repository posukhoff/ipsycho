import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ROUTE, parentRoute, parseRoute, routeHref, withoutLaunchParams } from "../../web/src/app/routes.ts";

/**
 * The fragment as a real Telegram client delivers it.
 *
 * A Mini App is launched with `tgWebAppData` and its siblings appended to the URL fragment — the
 * same fragment the router reads as its address. Nothing in the browser reproduces that: opened
 * from Chrome the app has no launch parameters, so every route parses and every check passes.
 * Opened from Telegram, the whole blob became the first path segment, every route resolved to
 * `notFound`, and because `parentRoute(notFound)` is `today` the back arrow appeared to navigate
 * forwards into the day. That is what these tests pin.
 */

const LAUNCH =
  "tgWebAppData=query_id%3DAAH%26user%3D%257B%2522id%2522%253A1%257D%26auth_date%3D1788676000%26signature%3Dabc%26hash%3Ddeadbeef" +
  "&tgWebAppVersion=8.0" +
  "&tgWebAppPlatform=ios" +
  "&tgWebAppThemeParams=%7B%22bg_color%22%3A%22%23ffffff%22%7D";

const TASK_ID = "3f1c9a52-0c1e-4d2f-9a71-0d2b6f5c8e10";

test("a launch with no route lands on today, not on not-found", () => {
  assert.deepEqual(parseRoute(`#${LAUNCH}`), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute(`#${LAUNCH}`), { name: "today" });
});

test("a deep link survives the launch parameters appended after it", () => {
  // A reminder's launch button carries `#/task/<id>`; Telegram appends its own blob to that.
  assert.deepEqual(parseRoute(`#/task/${TASK_ID}&${LAUNCH}`), { name: "task", id: TASK_ID });
  assert.deepEqual(parseRoute(`#/today&${LAUNCH}`), { name: "today" });
  assert.deepEqual(parseRoute(`#/week&${LAUNCH}`), { name: "week" });
});

test("a route's own query survives too, and is not mistaken for a launch parameter", () => {
  assert.deepEqual(parseRoute(`#/tasks?scope=month&${LAUNCH}`), { name: "tasks", scope: "month" });
  assert.deepEqual(parseRoute(`#/goals?scope=paused&${LAUNCH}`), { name: "goals", scope: "paused" });
});

test("stripping keeps every part that is not a launch parameter", () => {
  assert.equal(withoutLaunchParams(`#${LAUNCH}`), "");
  assert.equal(withoutLaunchParams(`#/task/${TASK_ID}&${LAUNCH}`), `/task/${TASK_ID}`);
  assert.equal(withoutLaunchParams("#/today"), "/today");
  assert.equal(withoutLaunchParams(""), "");
  // A name that merely starts with the same letters is not a launch parameter.
  assert.equal(withoutLaunchParams("#/tasks?q=tgWebApple=1"), "/tasks?q=tgWebApple=1");
});

test("an unrecognised route is still a not-found, and its parent is still today", () => {
  // The strip must not turn every wrong address into the default screen: a shared link with a
  // mistyped id has to say so rather than silently open the day.
  assert.deepEqual(parseRoute("#/task/not-a-uuid"), { name: "notFound" });
  assert.deepEqual(parseRoute("#/nonsense"), { name: "notFound" });
  assert.deepEqual(parentRoute({ name: "notFound" }), { name: "today" });
});

test("the fragments the bot emits parse to the screens they name", () => {
  // `src/telegram/telegram-webapp.ts` builds these; the two files have no compiler between them.
  for (const [fragment, expected] of [
    ["#/today", { name: "today" }],
    ["#/week", { name: "week" }],
    [`#/task/${TASK_ID}`, { name: "task", id: TASK_ID }],
    ["#/tasks/week", { name: "tasks", scope: "week" }],
    ["#/goals/active", { name: "goals", scope: "active" }],
    ["#/reminders", { name: "reminders" }],
    ["#/settings", { name: "settings" }],
    ["#/memory", { name: "memory" }],
    ["#/profile", { name: "profile" }],
  ]) {
    assert.deepEqual(parseRoute(fragment), expected, fragment);
    assert.deepEqual(parseRoute(`${fragment}&${LAUNCH}`), expected, `${fragment} with launch parameters`);
    assert.equal(routeHref(expected), fragment.startsWith("#/tasks/") || fragment.startsWith("#/goals/") ? routeHref(expected) : fragment, fragment);
  }
});
