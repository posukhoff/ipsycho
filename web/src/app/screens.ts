import type { ComponentType } from "react";
import type { Route, RouteName, ScreenDefinition } from "./routes.js";

/**
 * How the three screen groups plug into the shell without sharing a file.
 *
 * The rule in `AGENTS.md` is that no two writing agents share a file, and a registry that every
 * group has to add a line to is exactly such a file. So the shell *discovers* screens instead:
 * `import.meta.glob` picks up `src/screens/<anything>/index.ts` at build time, and each group's
 * `index.ts` — a file that group owns alone — exports what it implements.
 *
 * ```ts
 * // web/src/screens/tasks/index.ts, owned by group 6
 * import { defineScreen } from "../../app/routes.js";
 * import { TodayScreen } from "./today.js";
 * import { TaskScreen } from "./task.js";
 *
 * export const screens = [
 *   defineScreen("today", TodayScreen),
 *   defineScreen("task", TaskScreen),
 * ];
 * ```
 *
 * `defineScreen` is in `routes.js`, not here: a screen module calling a function this file exports
 * would close the loop the glob opens, and that cycle is what made a screen unrenderable outside a
 * browser. This file only collects.
 *
 * A route with no registered screen renders the not-found screen. That is deliberate: it means the
 * shell builds and runs with zero screens implemented, which is what lets groups 6, 7 and 8 start
 * the moment this lands instead of waiting for one another.
 */

interface ScreenModule {
  readonly screens?: readonly ScreenDefinition[];
  /** A module may also default-export the array. */
  readonly default?: readonly ScreenDefinition[];
}

const MODULES = import.meta.glob<ScreenModule>("../screens/*/index.{ts,tsx}", { eager: true });

function collect(): ReadonlyMap<RouteName, ComponentType<{ route: Route }>> {
  const registry = new Map<RouteName, ComponentType<{ route: Route }>>();
  for (const module of Object.values(MODULES)) {
    for (const screen of module.screens ?? module.default ?? []) {
      if (!registry.has(screen.name)) registry.set(screen.name, screen.component);
    }
  }
  return registry;
}

const REGISTRY = collect();

export function screenFor(name: RouteName): ComponentType<{ route: Route }> | undefined {
  return REGISTRY.get(name);
}
