import { defineScreen } from "../../app/routes.js";
import { SettingsScreen } from "./settings-screen.js";

export const screens = [defineScreen("settings", SettingsScreen)];
