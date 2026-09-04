# Verification notes

Verified locally and against production on 2026-08-22/23:

- `npm run check`: typecheck and build passed; 181 core tests and 52 application contract tests passed.
- `npm run test:e2e`: migration `0022_complex_planning_foundations.sql` applied from a clean PostgreSQL database; 17 PostgreSQL tests passed.
- E2E coverage includes workspace-scoped recurrence exclusions, task-batch rollback on an injected middle-step failure, optimistic concurrency, action journaling, audited rollout cancellation, mixed Undo, and Undo refusal after a later version change.
- Production deploy `ad42df6` completed successfully and the application container was healthy. The persistent production rollout flag remained disabled; provider QA enabled `TASK_BATCH_ENABLED=true` only in the isolated one-off process.
- The final provider-backed run used OpenAI `gpt-5.4-mini` and a synthetic isolated user/workspace. All 8 semantic checks passed: weekly evidence remained active through 1→3→4→5 provided dimensions, the final plan used existing outreach/interview/energy/commitment context without mutations, ambiguous goal advice produced a deterministic owned-goal choice, focused advice covered priorities/deferrals/hypotheses, and one natural-language mixed package applied two goal-linked creates plus one reschedule atomically.
- The mixed package was reversed through one Undo. Every production QA run deleted its synthetic user in `finally`; the final cleanup reported `workspace_residue=0`.
- Repeated production runs exposed and then verified repairs for premature three-question weekly completion, provider-claimed review evidence, duplicated clarification copy, equivalent structured/legacy schedule fields, actionless explicit task batches, ambiguous goal fallback, and OpenAI structured-output `ZodError` retry. Conflicting times and duplicate step IDs remain rejected by the strict schema/domain boundary.

Not claimed as complete: transaction-client refactoring of the existing primitive repositories (4.1), explicit queue-failure injection coverage (4.5), and real Telegram UI/delivery QA (8.5). Telegram Web was not authenticated in the available browser session; provider, production database, logs, atomic apply/Undo, and cleanup were verified through the isolated production runner instead.

The `openspec` CLI is not installed in this workspace, so artifact status was reviewed directly from `tasks.md`.

## Post-production-QA remediation (local, not deployed)

Implemented after the 2026-08-23 product QA:

- AI-inferred task/goal actions without an explicit user mutation request or an affirmative reply to a concrete prior offer are rejected before `handleProposed`; one structured repair must return an advisory-only turn. The application contract verifies that the low-energy pilot fixture reaches `handleProposed([])` and creates no pending group.
- Mixed task-operation intent is detected before provider execution while `TASK_BATCH_ENABLED=false`. The deterministic localized response states that nothing changed, does not reconfirm supplied time/timezone, and cannot create an action group.
- The Russian all-in-one weekly fixture now grounds outcome, capacity/energy, risks, minimum success, and commitments as five provided dimensions and completes without an assumptions label.
- Unclear-goal discovery guidance now requires known facts versus assumptions, no more than three provisional steps, one high-value constraint question, and `actions=[]` until explicit acceptance.

Verification after remediation:

- `npm run check`: 184 core tests and 55 application contract tests passed (239 total).
- `npm run test:e2e`: all 17 PostgreSQL tests passed; the disposable container and network were removed.
- The production deployment was not changed by this implementation session. Provider-backed and authenticated Telegram reruns remain release gates.
