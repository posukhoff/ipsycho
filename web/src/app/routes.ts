import type { ComponentType } from "react";
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

export interface ScreenDefinition {
  readonly name: RouteName;
  readonly component: ComponentType<{ route: Route }>;
}

/**
 * Binds a component to a route name, with the route type flowing into the component: `TaskScreen`
 * is declared as `({ route }: { route: RouteOf<"task"> }) => …`, reads `route.id` with no narrowing
 * inside the component, and cannot be registered under the wrong name.
 *
 * It lives here, next to the route union it types, rather than in `screens.ts` next to the registry
 * that collects it. `screens.ts` glob-imports every `screens/<group>/index.ts`, and those files
 * call this — so a `defineScreen` exported from `screens.ts`, or re-exported through `app/index.ts`,
 * is a cycle. The browser build hoists it into working order; Vite's SSR transform does not, and
 * `defineScreen is not a function` is what rendering a screen outside a browser used to produce.
 * `routes.ts` imports nothing from `app/`, so the registry can reach the screens and the screens
 * can reach this without either waiting on the other.
 */
export function defineScreen<Name extends RouteName>(name: Name, component: ComponentType<{ route: RouteOf<Name> }>): ScreenDefinition {
  // The registry is keyed by route name, so by the time the shell renders `component` the route it
  // passes is `RouteOf<Name>` by construction. One cast here replaces a narrowing in every screen.
  return { name, component: component as ComponentType<{ route: Route }> };
}

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

/**
 * Telegram's launch parameters, stripped out of the fragment before it is read as a route.
 *
 * A Mini App is opened with `tgWebAppData`, `tgWebAppVersion`, `tgWebAppThemeParams` and the rest
 * appended to the URL **fragment** — the same fragment this router uses as its address — and when
 * the link already carried a route they are appended to it. Dropping them here loses nothing:
 * `telegram-web-app.js` is loaded before this bundle and has already read them from
 * `location.hash`, and `Telegram.WebApp` keeps `initData` in memory afterwards.
 *
 * This is invisible outside a real client. A browser opens the app with no launch parameters, so
 * every route parses; opened from Telegram, the whole blob became the first path segment and every
 * route was `notFound` — whose parent is `today`, so the back arrow appeared to navigate forwards.
 */
export function withoutLaunchParams(fragment: string): string {
  const withoutHash = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  return withoutHash
    .split("&")
    .filter((part) => !/^tgWebApp[A-Za-z]*=/.test(part))
    .join("&");
}

/** Parses `#/task/<id>?x=1`. Anything unrecognised is a not-found, never a thrown error. */
export function parseRoute(fragment: string): Route {
  const withoutHash = withoutLaunchParams(fragment);
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
