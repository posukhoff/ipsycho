import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Every warning and error, appended to one file as JSON lines, so what the agent ran into while a
 * real person was using the bot can be read after the fact. Docker keeps the container's whole
 * stream — six services interleaved, capped at 10 MB and rotated away — which answers "is it up"
 * but not "how often does a turn get rejected, and with which code". This file answers the second.
 *
 * Off unless PROBLEM_LOG_FILE names a path, so development and tests write nothing. Each line is
 * the same sanitized record that goes to stderr: identifiers, counters and error identity, never a
 * message body (AGENTS.md). Lines from one Telegram turn share `updateId` and `userId`, which is
 * what makes a single person's bad evening reconstructable.
 */
export interface ProblemSink {
  record(line: string): void;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const NO_OP: ProblemSink = { record: () => undefined };

export function createProblemSink(env: NodeJS.ProcessEnv): ProblemSink {
  const file = env.PROBLEM_LOG_FILE?.trim();
  if (!file) return NO_OP;
  const parsedMax = Number(env.PROBLEM_LOG_MAX_BYTES ?? DEFAULT_MAX_BYTES);
  const maxBytes = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : DEFAULT_MAX_BYTES;

  let bytes: number | null = null;
  let stopped = false;

  return {
    record(line: string): void {
      if (stopped) return;
      try {
        if (bytes === null) {
          mkdirSync(dirname(file), { recursive: true });
          bytes = fileSize(file);
        }
        const payload = `${line}\n`;
        // One previous generation is kept. Two files bound the disk without a rotation daemon, and
        // an incident older than the last 16 MB of warnings is one the logs no longer help with.
        if (bytes > 0 && bytes + payload.length > maxBytes) {
          renameSync(file, `${file}.1`);
          bytes = 0;
        }
        appendFileSync(file, payload);
        bytes += payload.length;
      } catch (error) {
        // A log that cannot be written must not take a turn down with it: say so once, on the
        // stream that still works, and stay quiet afterwards.
        stopped = true;
        process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "problem log disabled", file, reason: errorName(error) })}\n`);
      }
    },
  };
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "unknown";
}
