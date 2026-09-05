import type { GoalScope, TaskScope } from "../api/contracts.js";

/**
 * Routing on the URL fragment.
 *
 * The fragment is how a deep link from chat arrives — `${WEBAPP_URL}/#/task/<id>` — and keeping the
 * id after the `#` is deliberate: a fragment is never sent to the server, so it never reaches
 * Caddy's access log or an upstream proxy (task 10.1).
 *
 * The consequence, stated once here so no screen has to repeat it: **a route is a hint, not an
 * authorization**. Anyone who receives a shared link can edit the id in it. Nothing here checks
 * whether the user may see an object; it only checks that the shape could be an id at all, so the
 * client does not fire a request built from junk. The server scopes by workspace and answers
 * `not_found` for someone else's id, and `useQuery(...).isNotFound` is what a screen renders — a
 * not-found screen, never an error.
 */

export type Route =
  | { readonly name: "today" }
  | { readonly name: "tasks"; readonly scope: TaskScope }
  | { readonly name: "task"; readonly id: string }
  | { readonly name: "taskEdit"; readonly id: string }
  | { readonly name: "taskNew" }
  | { readonly name: "pausedSeries" }
  | { readonly name: "week" }
  | { readonly name: "goals"; readonly scope: GoalScope }
  | { readonly name: "goal"; readonly id: string }
  | { readonly name: "reminders" }
  | { readonly name: "settings" }
  | { readonly name: "memory" }
  | { readonly name: "profile" }
  | { readonly name: "notFound" };

export type RouteName = Route["name"];

/** `RouteOf<"task">` is `{ name: "task"; id: string }` — what a screen component receives. */
export type RouteOf<Name extends RouteName> = Extract<Route, { name: Name }>;

export const DEFAULT_ROUTE: Route = { name: "today" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const TASK_SCOPES: readonly TaskScope[] = ["overdue", "today", "week", "month", "all", "nodate"];
const GOAL_SCOPES: readonly GoalScope[] = ["active", "paused", "completed"];

function taskScope(value: string | undefined): TaskScope {
  return TASK_SCOPES.find((scope) => scope === value) ?? "week";
}

function goalScope(value: string | undefined): GoalScope {
  return GOAL_SCOPES.find((scope) => scope === value) ?? "active";
}

/** Parses `#/task/<id>?x=1`. Anything unrecognised is a not-found, never a thrown error. */
export function parseRoute(fragment: string): Route {
  const withoutHash = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const [pathPart = "", queryPart = ""] = withoutHash.split("?", 2);
  const query = new URLSearchParams(queryPart);
  const segments = pathPart.split("/").filter((segment) => segment.length > 0);
  const [head, second] = segments;

  if (head === undefined) return DEFAULT_ROUTE;

  switch (head) {
    case "today":
      return { name: "today" };
    case "tasks":
      return { name: "tasks", scope: taskScope(second ?? query.get("scope") ?? undefined) };
    case "paused":
      return { name: "pausedSeries" };
    case "new":
      return { name: "taskNew" };
    case "task": {
      if (second === undefined || !UUID.test(second)) return { name: "notFound" };
      return segments[2] === "edit" ? { name: "taskEdit", id: second } : { name: "task", id: second };
    }
    case "week":
      return { name: "week" };
    case "goals":
      return { name: "goals", scope: goalScope(second ?? query.get("scope") ?? undefined) };
    case "goal":
      return second !== undefined && UUID.test(second) ? { name: "goal", id: second } : { name: "notFound" };
    case "reminders":
      return { name: "reminders" };
    case "settings":
      return { name: "settings" };
    case "memory":
      return { name: "memory" };
    case "profile":
      return { name: "profile" };
    default:
      return { name: "notFound" };
  }
}

/** The path half of a fragment, without the `#`. */
export function routePath(route: Route): string {
  switch (route.name) {
    case "today":
      return "/today";
    case "tasks":
      return `/tasks/${route.scope}`;
    case "pausedSeries":
      return "/paused";
    case "taskNew":
      return "/new";
    case "task":
      return `/task/${route.id}`;
    case "taskEdit":
      return `/task/${route.id}/edit`;
    case "week":
      return "/week";
    case "goals":
      return `/goals/${route.scope}`;
    case "goal":
      return `/goal/${route.id}`;
    case "reminders":
      return "/reminders";
    case "settings":
      return "/settings";
    case "memory":
      return "/memory";
    case "profile":
      return "/profile";
    case "notFound":
      return "/404";
  }
}

/** What an `<a href>` needs. */
export function routeHref(route: Route): string {
  return `#${routePath(route)}`;
}

export function sameRoute(a: Route, b: Route): boolean {
  return routePath(a) === routePath(b);
}

/**
 * The five root screens. A root shows the tab bar and no back button; everything else is a push.
 */
export const ROOT_ROUTES: readonly Route[] = [{ name: "today" }, { name: "tasks", scope: "week" }, { name: "week" }, { name: "reminders" }, { name: "settings" }];

export function isRootRoute(route: Route): boolean {
  return ROOT_ROUTES.some((root) => root.name === route.name);
}

/**
 * Where back goes when there is no history to pop — which is the normal case for a deep link
 * opened straight from a reminder message.
 */
export function parentRoute(route: Route): Route | null {
  switch (route.name) {
    case "task":
    case "taskNew":
    case "pausedSeries":
      return { name: "tasks", scope: "week" };
    case "taskEdit":
      return { name: "task", id: route.id };
    case "goal":
      return { name: "goals", scope: "active" };
    case "goals":
    case "memory":
    case "profile":
      return { name: "settings" };
    case "notFound":
      return { name: "today" };
    default:
      return null;
  }
}

/**
 * `start_param` as a navigation hint.
 *
 * Telegram restricts it to `[A-Za-z0-9_-]{0,64}`, so it cannot carry a path; group 10 puts the id
 * in the fragment for that reason. What it can carry is a screen name, and `t_<uuid>` for the one
 * case where a launch button has no fragment to work with. Same rule as the fragment: a hint.
 */
export function routeFromStartParam(param: string | null): Route | null {
  if (!param) return null;
  const [head, rest] = param.split("_", 2);
  if (head === "t" && rest !== undefined && UUID.test(rest)) return { name: "task", id: rest };
  if (head === "g" && rest !== undefined && UUID.test(rest)) return { name: "goal", id: rest };
  const route = parseRoute(`/${param}`);
  return route.name === "notFound" ? null : route;
}
