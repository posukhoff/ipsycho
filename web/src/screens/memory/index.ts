import { defineScreen } from "../../app/routes.js";
import { MemoryScreen } from "./memory-screen.js";

export const screens = [defineScreen("memory", MemoryScreen)];
