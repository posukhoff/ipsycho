import type { Importance } from "./types.js";

export type ResultCheckChoice = "15m" | "1h" | "evening";

export function defaultResultCheckChoice(importance: Importance): ResultCheckChoice {
  if (importance === "critical") return "15m";
  return "1h";
}

export function resultCheckDelayMinutes(choice: Exclude<ResultCheckChoice, "evening">): number {
  return choice === "15m" ? 15 : 60;
}

export const RESULT_CHECK_IGNORE_GRACE_MINUTES = 120;
