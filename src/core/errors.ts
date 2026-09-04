/**
 * A rule of the domain that the requested change violates: a stale version, a terminal
 * occurrence, a reason that is required, a time in the past. Raised from repositories and
 * services on the write path. The chat layer turns it into a deterministic reply for the
 * user; everything else that is thrown is an actual failure and is retried or reported.
 */
export class DomainRuleError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DomainRuleError";
  }
}

export function isDomainRuleError(error: unknown): error is DomainRuleError {
  return error instanceof DomainRuleError;
}
