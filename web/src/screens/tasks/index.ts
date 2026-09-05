import { defineScreen } from "../../app/index.js";
import { TaskScreen } from "./detail.js";
import { TaskEditScreen, TaskNewScreen } from "./form.js";
import { TasksScreen } from "./list.js";
import { PausedSeriesScreen } from "./paused.js";

/**
 * What group 6 registers with the shell.
 *
 * The shell discovers this file by glob (`src/screens/<group>/index.ts`), so nothing shared has to be
 * edited to add a screen and three groups can land theirs in parallel. `defineScreen` is what makes
 * the route type flow into the component: `TaskScreen` declares `route: RouteOf<"task">` and reads
 * `route.id` with no narrowing.
 */
export const screens = [
  defineScreen("tasks", TasksScreen),
  defineScreen("task", TaskScreen),
  defineScreen("taskEdit", TaskEditScreen),
  defineScreen("taskNew", TaskNewScreen),
  defineScreen("pausedSeries", PausedSeriesScreen),
];
