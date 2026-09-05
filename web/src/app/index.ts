/**
 * Routing and the shell, in one import.
 *
 * ```ts
 * import { defineScreen, useRoute, useNavigate, Link, useMe, useTodayLocalDate } from "../../app/index.js";
 * ```
 */
export { App } from "./app.js";
export { Boot, useMe, useRefreshMe, useSettings, useTimezone, useTodayLocalDate } from "./boot.js";
export { Link, RouterProvider, useBackInterceptor, useNavigate, useRoute, type Navigator } from "./router.js";
export {
  DEFAULT_ROUTE,
  ROOT_ROUTES,
  isRootRoute,
  parentRoute,
  parseRoute,
  routeFromStartParam,
  routeHref,
  routePath,
  sameRoute,
  type Route,
  type RouteName,
  type RouteOf,
} from "./routes.js";
export { defineScreen, hasScreen, screenFor, type ScreenDefinition } from "./screens.js";
export { Shell } from "./shell.js";
