export interface SafeError {
  name: string;
  message?: string;
  code?: string;
  status?: number;
  constraint?: string;
  detail?: string;
  routine?: string;
}

/**
 * Logs useful technical details without preserving a stack or credentials.
 * Provider and database errors may echo connection strings, so messages are
 * redacted and bounded before being sent to logs.
 */
export function safeError(error: unknown): SafeError {
  const name = error instanceof Error ? error.name : "UnknownError";
  if (!error || typeof error !== "object") return { name };
  const source = error as {
    message?: unknown; description?: unknown; detail?: unknown; code?: unknown;
    status?: unknown; constraint?: unknown; routine?: unknown;
  };
  const message = typeof source.message === "string" ? redactMessage(source.message) : undefined;
  const detail = redactMessage(typeof source.description === "string" ? source.description : typeof source.detail === "string" ? source.detail : "");
  const code = safeIdentifier(source.code);
  const constraint = safeIdentifier(source.constraint);
  const routine = safeIdentifier(source.routine);
  const status = typeof source.status === "number" && Number.isInteger(source.status) && source.status >= 100 && source.status <= 599
    ? source.status
    : undefined;
  return {
    name,
    ...(message ? { message } : {}),
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
    ...(constraint ? { constraint } : {}),
    ...(detail ? { detail } : {}),
    ...(routine ? { routine } : {}),
  };
}

/**
 * Removes common credentials before data leaves the process or is written to a
 * human-readable log. It deliberately preserves ordinary user text: this is
 * not a substitute for consent or access control.
 */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/(?:postgres(?:ql)?:\/\/|https?:\/\/)[^\s@/]+@/gi, "[redacted-url]@")
    .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{16,}\b/g, "[redacted-api-key]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted-api-key]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-bot-token]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted-access-key]")
    .replace(/(\b(?:password|passwd|token|api[_-]?key|authorization|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
}

/** Console logs must be useful without becoming an unprotected second message store. */
export function safeMessageMetadata(text: string): { length: number; sha256: string } {
  return {
    length: text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

function redactMessage(message: string): string | undefined {
  const redacted = redactSensitiveText(message);
  const compact = redacted.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 300) : undefined;
}
import { createHash } from "node:crypto";
