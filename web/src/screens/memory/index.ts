import { defineScreen } from "../../app/index.js";
import { MemoryScreen } from "./memory-screen.js";

export const screens = [defineScreen("memory", MemoryScreen)];
