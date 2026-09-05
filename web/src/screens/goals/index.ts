import { defineScreen } from "../../app/routes.js";
import { GoalScreen } from "./detail.js";
import { GoalsScreen } from "./list.js";

/** The two goal routes group 6 owns. The shell picks this file up by glob; see `app/screens.ts`. */
export const screens = [defineScreen("goals", GoalsScreen), defineScreen("goal", GoalScreen)];
