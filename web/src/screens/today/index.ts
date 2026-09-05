import { defineScreen } from "../../app/routes.js";
import { TodayScreen } from "./today-screen.js";

/**
 * What this folder registers with the shell.
 *
 * The shell discovers screens by globbing `src/screens/<name>/index.ts` (`app/screens.ts`), so this file
 * is the whole registration — there is no shared registry for three parallel groups to collide in.
 */
export const screens = [defineScreen("today", TodayScreen)];
