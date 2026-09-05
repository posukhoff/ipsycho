import { defineScreen } from "../../app/index.js";
import { WeekScreen } from "./week-screen.js";

/**
 * What this folder registers with the shell.
 *
 * The shell discovers screens by globbing `src/screens/<name>/index.ts` (`app/screens.ts`), so this
 * file is the whole registration — there is no shared registry for three parallel groups to collide
 * in, and a route with no screen simply renders the not-found one.
 */
export const screens = [defineScreen("week", WeekScreen)];
