import type { ComponentType } from "react";
import type { Route, RouteName, RouteOf } from "./routes.js";

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
 * import { defineScreen } from "../../app/screens.js";
 * import { TodayScreen } from "./today.js";
 * import { TaskScreen } from "./task.js";
 *
 * export const screens = [
 *   defineScreen("today", TodayScreen),
 *   defineScreen("task", TaskScreen),
 * ];
 * ```
 *
 * `defineScreen` is what makes the route type flow into the component: `TaskScreen` is declared as
 * `({ route }: { route: RouteOf<"task"> }) => …` and gets `route.id` typed as a string, with no
 * narrowing inside the component and no way to register it under the wrong route name.
 *
 * A route with no registered screen renders the not-found screen. That is deliberate: it means the
 * shell builds and runs with zero screens implemented, which is what lets groups 6, 7 and 8 start
 * the moment this lands instead of waiting for one another.
 */

export interface ScreenDefinition {
  readonly name: RouteName;
  readonly component: ComponentType<{ route: Route }>;
}

export function defineScreen<Name extends RouteName>(name: Name, component: ComponentType<{ route: RouteOf<Name> }>): ScreenDefinition {
  // The registry is keyed by route name, so by the time the shell renders `component` the route it
  // passes is `RouteOf<Name>` by construction. One cast here replaces a narrowing in every screen.
  return { name, component: component as ComponentType<{ route: Route }> };
}

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

export function hasScreen(name: RouteName): boolean {
  return REGISTRY.has(name);
}
