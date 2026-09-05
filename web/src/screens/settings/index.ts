import { defineScreen } from "../../app/index.js";
import { SettingsScreen } from "./settings-screen.js";

export const screens = [defineScreen("settings", SettingsScreen)];
