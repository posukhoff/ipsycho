import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One JSON line per event, with a level, a timestamp and whatever the caller attached.
 * Fields go through unchanged; callers pass identifiers, counts and `safeError(...)`,
 * never message bodies (see AGENTS.md). LOG_LEVEL hides levels below it.
 *
 * `runWithLogContext` binds fields to everything logged while an async task runs, so one
 * Telegram update's turn id appears on every line it produced without being threaded through.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const threshold = LEVEL_RANK[(configured in LEVEL_RANK ? configured : "info") as LogLevel];

const context = new AsyncLocalStorage<LogFields>();

export function runWithLogContext<T>(fields: LogFields, work: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, work);
}

function emit(level: LogLevel, event: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...context.getStore(), ...fields });
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};
