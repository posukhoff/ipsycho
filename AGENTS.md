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
- `docs/`, `README.md`, and `MANUAL_ACTIONS.md`: product, deployment, and manual-verification guidance.

## Discovery and planning

- Prefer the Codebase Memory graph for structural discovery: `search_graph`, `trace_path`, `get_code_snippet`, then `check_index_coverage` for every material path. Use `rg` for literals, configuration, documentation, and any reported coverage gaps.
- For a complex or ambiguous change, inspect the affected call paths and write a short plan before editing. Reuse an existing OpenSpec change when the user is working through one.
- Make the smallest behavior-preserving change that satisfies the request. Preserve unrelated user changes and avoid new production dependencies unless the user authorizes them.

## Safety invariants

- AI and Telegram input is untrusted. Keep structured parsing, Zod validation, ownership checks, optimistic versions, and domain validation at mutation boundaries.
- Scope reads and writes by `workspaceId` and the acting user where applicable. Never weaken composite workspace foreign keys or membership checks.
- Check provider consent at the provider boundary, including retries and voice transcription. Do not add automatic cross-provider fallback.
- Commit a state mutation and its action journal atomically where supported. Risky or inferred actions require confirmation; expose Undo only for truthfully reversible state.
- Logs may contain identifiers, counters, and sanitized error identity, but not message bodies, secrets, access tokens, raw provider payloads, or sensitive memory.
- Keep migration locking and the single-app-process assumption intact. Treat Telegram delivery as a non-transactional external side effect and design retries for ambiguous outcomes.

## Verification

- Node.js 24+ is required.
- Run `npm run check` for TypeScript or application changes. It performs typecheck, build, core tests, and app contract tests.
- Run `npm run test:e2e` for migrations, repositories, transactions, workspace constraints, reminder persistence, or PostgreSQL behavior. It requires Docker.
- Run `npm audit` only when dependency or release risk is in scope; it may require network access.
- Before finishing, review the diff for accidental scope growth, missing tests, privacy regressions, and stale documentation. Record any check that could not run and why.

## Subagents

- When the user asks for parallel agents, delegate bounded, independent, read-heavy work such as code-path mapping, review, test analysis, or documentation research.
- Prefer the project agents in `.codex/agents/`. Keep the main agent responsible for requirements and the final decision.
- Avoid parallel edits to overlapping files. Every writing agent must own explicit files and must preserve changes made by others.

## Code Review Rules

Use [docs/CODE_REVIEW.md](docs/CODE_REVIEW.md) for the full checklist. Prioritize these repository-specific invariants:

- **Workspace isolation:** flag any query or relation that can access an object without its workspace/member scope. Safe path: include workspace predicates and preserve composite constraints.
- **Untrusted AI actions:** flag AI output that reaches a mutation without schema, ownership, version, and domain validation. Safe path: validate at the deterministic action boundary.
- **Consent and privacy:** flag provider calls without a boundary consent check or logs containing user/provider content. Safe path: recheck consent immediately before the call and log sanitized metadata only.
- **Mutation integrity:** flag state changes separated from their action journal or Undo claims that cannot restore the prior state. Safe path: use one transaction and expose only truthful rollback.
- **External retries:** flag retry logic that assumes a Telegram/network timeout means nothing happened. Safe path: make operations idempotent or represent the outcome as ambiguous.
