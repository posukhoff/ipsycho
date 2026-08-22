# Verification notes

Verified locally on 2026-08-22:

- `npm run check`: typecheck and build passed; 179 core tests and 46 application contract tests passed.
- `npm run test:e2e`: migration `0022_complex_planning_foundations.sql` applied from a clean PostgreSQL database; 17 PostgreSQL tests passed.
- E2E coverage includes workspace-scoped recurrence exclusions, task-batch rollback on an injected middle-step failure, optimistic concurrency, action journaling, audited rollout cancellation, mixed Undo, and Undo refusal after a later version change.

Not claimed as complete: transaction-client refactoring of the existing primitive repositories (4.1), explicit queue-failure injection coverage (4.5), provider-scored advice fixtures (5.4), the named Monday/evening semantic fixture (6.5), provider-backed QA script (8.1), production-like staged rehearsal (8.4), and real Telegram/provider cleanup QA (8.5).

The `openspec` CLI is not installed in this workspace, so artifact status was reviewed directly from `tasks.md`.
