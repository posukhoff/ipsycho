# IPsycho code review checklist

Review for consequential defects first. Report concrete findings with file and line references, the affected behavior, and a safe remediation. Skip style-only comments unless they hide a correctness or maintenance risk.

## Correctness and contracts

- Trace the real entry point through validation, persistence, queueing, and delivery; do not judge an isolated helper without its callers.
- Check time and recurrence behavior across user timezones, DST transitions, point/window/deadline semantics, and occurrence-versus-series scope.
- Preserve optimistic-version checks and make retries, callbacks, and queue handlers safe against duplicate or stale work.
- Treat public Telegram commands, callback payloads, persisted action shapes, environment variables, and migrations as compatibility surfaces.

## Authorization and privacy

- Verify every user-owned read and mutation is constrained by workspace membership and the relevant user or recipient.
- Verify AI-provider consent is checked immediately before every provider boundary, including retries and transcription.
- Keep sensitive memory out of retrieved provider context unless the product contract explicitly permits it.
- Reject logs, exceptions, metrics, or audit data that expose message bodies, prompts, provider payloads, tokens, secrets, or sensitive memory.

## Mutations and persistence

- Validate AI-proposed actions with structured parsing, Zod schemas, ownership, optimistic versions, and domain rules before applying them.
- Keep the domain change and its action journal in one transaction where supported; check partial-failure behavior for other side effects.
- Confirm inferred or risky actions and ensure every advertised Undo represents a truthful rollback.
- For migrations, add a forward-only numbered file, preserve workspace constraints, and run the PostgreSQL E2E suite.

## External effects and operations

- Assume Telegram and provider timeouts can be ambiguous. Review idempotency, deduplication, and retry limits accordingly.
- Preserve the single-app-process and migration-lock assumptions unless the change explicitly redesigns them.
- Review deployment, backup, restore, or environment changes against `docs/DEPLOYMENT.md` and `MANUAL_ACTIONS.md`.

## Tests and evidence

- Require focused regression coverage for changed behavior: `tests/core/` for pure logic, `tests/app/` for application contracts, and `tests/e2e/` for PostgreSQL invariants.
- Run `npm run check`; add `npm run test:e2e` when persistence or migrations are affected.
- State checks that were not run, environmental limitations, and any remaining risk.
