/**
 * What a screen imports from the shell.
 *
 * ```ts
 * import { useNavigate, Link, useMe, useTodayLocalDate, type RouteOf } from "../../app/index.js";
 * ```
 *
 * `defineScreen` is deliberately **not** here: a screen module registering itself through this
 * barrel closes the loop `screens.ts`'s glob opens, and that cycle is what made a screen
 * unrenderable outside a browser. It comes from `../../app/routes.js` instead.
 *
 * `App`, `Boot`, `Shell`, `RouterProvider` and the route helpers are not here either — `app/` wires
 * itself from the concrete files, and nothing outside it names them.
 */
export { useMe, useSettings, useTimezone, useTodayLocalDate } from "./boot.js";
export { Link, useBackInterceptor, useNavigate } from "./router.js";
export type { Route, RouteOf } from "./routes.js";
