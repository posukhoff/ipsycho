/**
 * Whether an error means the connection to PostgreSQL broke, so a statement that was in
 * flight (a COMMIT in particular) may or may not have taken effect on the server.
 */
export function isConnectionLevelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    // 08xxx: connection exception; 57P01..57P03: server shutdown / cannot connect now.
    if (code.startsWith("08") || code === "57P01" || code === "57P02" || code === "57P03") return true;
    if (["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED"].includes(code)) return true;
  }
  return /connection terminated|terminating connection|connection timeout|timeout exceeded when trying to connect/i.test(error.message);
}
