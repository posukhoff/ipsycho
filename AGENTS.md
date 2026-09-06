# IPsycho agent guide

## Product contract

- IPsycho is a private, allowlisted Telegram assistant. Preserve workspace isolation, explicit-consent boundaries, deterministic validation, and recoverable mutations.
- Treat [README.md](README.md) as the operational overview and `docs/Implementation_Baseline_v10.pdf` as the product contract. Update docs when behavior or operator steps change.
- Use `.env.example` for configuration discovery. Do not read, print, or modify `.env` unless the user explicitly asks for work that requires it.

## Repository map

- `src/core/`: pure domain and time logic; prefer focused unit tests in `tests/core/`.
- `src/`: NestJS services, repositories, provider adapters, Telegram handlers, and the application entry point.
- `migrations/`: ordered PostgreSQL migrations. Add a new numbered migration; do not rewrite a migration that may already have run.
- `tests/app/`: application contract tests. `tests/e2e/`: PostgreSQL integration coverage.
- `web/`: the Telegram Mini App (Vite + React), an npm workspace built from the server's own zod contracts in `src/api/contracts/`.
- `README.md` plus `docs/`: the operational overview, then `DEPLOYMENT.md` (server and backups), `MANUAL_ACTIONS.md` (release checks needing a real Telegram account), `AGENT_FLOW.md` (agent behaviour), `CODE_REVIEW.md`.

## Discovery and planning

- Use `rg` for discovery: literals, configuration, documentation and call paths. Read a whole file before changing it; the comments carry the reasoning that the code alone does not.
- For a complex or ambiguous change, inspect the affected call paths and write a short plan before editing.
- Make the smallest behavior-preserving change that satisfies the request. Preserve unrelated user changes and avoid new production dependencies unless the user authorizes them.

## Safety invariants

- AI and Telegram input is untrusted. Keep structured parsing, Zod validation, ownership checks, optimistic versions, and domain validation at mutation boundaries.
- Scope reads and writes by `workspaceId` and the acting user where applicable. Never weaken composite workspace foreign keys or membership checks.
- Check provider consent at the provider boundary, including retries and voice transcription. Do not add automatic cross-provider fallback.
- Commit a state mutation and its action journal atomically where supported. Risky or inferred actions require confirmation; expose Undo only for truthfully reversible state.
- Logs may contain identifiers, counters, and sanitized error identity, but not message bodies, secrets, access tokens, raw provider payloads, or sensitive memory.
- Keep migration locking and the single-app-process assumption intact. Treat Telegram delivery as a non-transactional external side effect and design retries for ambiguous outcomes.

Load-bearing details that read as arbitrary and are not:

- `src/core/` imports nothing from outside itself; that is what lets it be tested on its own.
- Action mutations lock with `FOR UPDATE ORDER BY id` inside the transaction; the order is the deadlock avoidance, not a style.
- No `parse_mode` anywhere in Telegram output. The whole class of escaping bugs is absent because nothing is ever parsed as markup.
- `callback_data` is at most 64 bytes and every uuid in it is matched by a regex before use.
- `src/core/applied-report.ts` reports only what was actually stored, with the value before and after. A report of what was attempted would be a lie the user cannot check.
- Every code in `src/chat/turn-errors.ts` says what the user can change. A code that only says what failed is not finished.
- `scripts/backup-compose.sh` publishes atomically and proves the archive by decrypting it before publishing, not after.
- Do not lower the coverage threshold in `.c8rc.json`.

## Verification

- Node.js 24+ is required.
- Run `npm run check` for TypeScript or application changes. It performs typecheck, build, core tests, and app contract tests.
- Run `npm run test:e2e` for migrations, repositories, transactions, workspace constraints, reminder persistence, or PostgreSQL behavior. It requires Docker.
- Run `npm audit` only when dependency or release risk is in scope; it may require network access.
- Before finishing, review the diff for accidental scope growth, missing tests, privacy regressions, and stale documentation. Record any check that could not run and why.

## Subagents

- When the user asks for parallel agents, delegate bounded, independent, read-heavy work such as code-path mapping, review, test analysis, or documentation research.
- Keep the main agent responsible for requirements and the final decision.
- Avoid parallel edits to overlapping files. Every writing agent must own explicit files and must preserve changes made by others.

## Code Review Rules

Use [docs/CODE_REVIEW.md](docs/CODE_REVIEW.md) for the full checklist. Prioritize these repository-specific invariants:

- **Workspace isolation:** flag any query or relation that can access an object without its workspace/member scope. Safe path: include workspace predicates and preserve composite constraints.
- **Untrusted AI actions:** flag AI output that reaches a mutation without schema, ownership, version, and domain validation. Safe path: validate at the deterministic action boundary.
- **Consent and privacy:** flag provider calls without a boundary consent check or logs containing user/provider content. Safe path: recheck consent immediately before the call and log sanitized metadata only.
- **Mutation integrity:** flag state changes separated from their action journal or Undo claims that cannot restore the prior state. Safe path: use one transaction and expose only truthful rollback.
- **External retries:** flag retry logic that assumes a Telegram/network timeout means nothing happened. Safe path: make operations idempotent or represent the outcome as ambiguous.

## Two surfaces

The chat and the Mini App are one product with one journal. Which surface a thing belongs to is decided by a single rule, and the rest of this section is the small number of decisions that look like bugs and get "fixed" wrongly.

- **Reaction and conversation stay in the chat; browsing moves to the app.** A button belongs in a Telegram message only if it answers that message, in the moment it arrives, in about six buttons: the confirmation card, Undo, the reminder card and its snooze/preset/reason. Anything that means reading a list, choosing among many, or entering a value is browsing, and the bot deliberately no longer has it. Adding a screen back to `src/telegram/` is how the two competing control models return.
- **A write from the app must journal exactly like the same change from a button, or Undo lies.** Every `src/api/**` write goes through `ActionsService`/`TasksService`/`SettingsService`; a response carrying `undoGroupId: null` is claiming the change is not reversible, and it has to be true.
- **`src/api/**` is a presentation layer.** It may not import `drizzle-orm` or touch a repository — `tests/app/webapp-flag.test.mjs` enforces this, including dynamic imports.
- **`initData`: `signature` is part of the data-check string; only `hash` is excluded.** The third-party-validator recipe excludes both, which makes every real client fail, and the plausible fix is loosening the check. Absent `user` is a refusal with no fallback.
- **The Caddyfile has no catch-all `reverse_proxy`.** Caddy answers an unmatched path with an empty 200, so a catch-all publishes `/health` and `/ready` — the commit SHA, the database state and the loop names. Match `/app` and `/app/*` explicitly, never `/app*`, which also matches `/apple`.
- **No `X-Frame-Options`.** Telegram Web opens Mini Apps in an iframe and `DENY` renders a blank page, whose obvious fix under pressure is deleting the CSP with it. Framing is restricted by `frame-ancestors`; `script-src` stays free of `'unsafe-inline'`, because the API is same-origin with no cookie and an XSS there is account control.
- **The router ignores Telegram's launch parameters.** A Mini App is opened with `tgWebAppData` and its siblings appended to the URL fragment — the same fragment the router reads as its address. Nothing in a browser reproduces that, so this is not something tests will catch for you.
- **The Caddyfile is bind-mounted, so a change to it is invisible to `docker compose up`.** `scripts/deploy-remote.sh` validates and restarts the edge for that reason; without it every edge rule deploys as a silent no-op.
- **Rollback for the reduced bot is a revert, not `WEBAPP_ENABLED=false`.** With the flag off the bot still has the conversation, the cards and the account gates, but nothing to browse with.

- `src/database/schema.ts` must match the applied migrations: `tests/e2e/schema-drift.test.mjs` compares tables, index and constraint names, and foreign keys with their `ON DELETE` behaviour against the live database. Add the SQL migration and the schema declaration in the same change.

## Decisions already taken

Settled, with the reason, so they are not re-argued from scratch. Changing one is a product decision; discovering one is not.

- **No habits.** A repeating task with no end date already is one.
- **No "Started" button**, and no new `in_progress` rows. The value stays in the enum and is read for old rows, so every occurrence has one card shape.
- **Memory, goals and `plan` stay model actions.** A task cannot reference a goal created in the same message, so without `plan` "a goal and its first steps" would break into two turns.
- **Pausing a series is offered only for repeats with no end date.** Pausing a series that has one only loses dates.
- **The bot has no browsing screens.** They moved to the Mini App; the chat keeps the conversation, the reaction cards and the deterministic gates. Rollback is a revert, not `WEBAPP_ENABLED=false`.
- **The Mini App has no chat screen and no goal creation.** The app opens inside the chat, so a second conversational surface would need its own turn identity, a migration and an async lifecycle to save a swipe; and a goal is a sentence, not a form.

Deliberately not refactored, each because the obvious split breaks a transaction:

- `action-mutations.repository.ts` is not carved up: one step is one transaction there.
- Repositories are not lifted out of `AccessService`, `reminder-*` or `briefing-*`: account deletion, delivery suppression and audit are each one transaction, and a wrapper would tear it.
- `briefing-content` and `reminder-queue` still call `telegram-ui`: that is the delivery path into Telegram, not presentation leaking into the domain.
- The rate limiter ignores in-flight turns: one chat's updates are already strictly sequential (`sequentialize`), so the only race is between a live turn and `AiRetryService`.
