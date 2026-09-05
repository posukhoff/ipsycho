import { defineScreen } from "../../app/index.js";
import { RemindersScreen } from "./reminders-screen.js";

/** Discovered by the shell's glob; no shared registry to edit, so no collision with groups 6 and 7. */
export const screens = [defineScreen("reminders", RemindersScreen)];
