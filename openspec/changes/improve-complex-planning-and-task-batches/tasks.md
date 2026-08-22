## 1. Persistence and recurrence foundations

- [x] 1.1 Add the next append-only migration for nullable task recurrence end dates, workspace-scoped recurrence exclusions, and nullable conversation review state; verify forward migration and startup against an existing database with `npm run test:e2e`.
- [x] 1.2 Extend Drizzle schema and task record mappers for recurrence end dates and exclusions while preserving existing unbounded tasks; verify schema typecheck and mapper unit tests.
- [x] 1.3 Introduce a structured recurrence input model for frequency, interval, weekdays/month days, start, end, local times, and finite exclusions; verify unit tests reject unsupported fields and invalid bounds.
- [x] 1.4 Update occurrence projection and recurrence maintenance to stop after the local end date and filter excluded dates before reminders are materialized; verify core tests cover DST, every-second-week cadence, end-date inclusivity, and the first-occurrence exclusion.
- [x] 1.5 Add repository read/write support for recurrence exclusions with composite workspace/task constraints; verify PostgreSQL e2e tests reject cross-workspace links and duplicate exclusions.

## 2. Local scheduling and temporal fidelity

- [x] 2.1 Add structured local schedule fields for exact, window, date-only, deadline, and fuzzy modes and compile them with existing timezone helpers; verify unit tests cover Kyiv DST transitions and mode-specific field rejection.
- [x] 2.2 Add compatibility normalization for legacy ISO timestamps so equivalent UTC and explicit-offset instants canonicalize to the declared timezone while conflicting local fields fail; verify regression tests for the production `Z` versus `+03:00` failure.
- [x] 2.3 Update task creation, update, reschedule, and series conversion to use compiled local scheduling and structured recurrence; verify application tests preserve colloquial `09:30`, deadline-only, fuzzy, duration, interval, and bounded-series semantics.
- [x] 2.4 Update the AI action schema and system prompt to emit structured local time and recurrence instead of provider-authored RRULE strings; verify schema tests reject `BYSETPOS`, fabricated exact times, and unsupported exception approximations.

## 3. Task-batch contract and compilation

- [x] 3.1 Define the `task_batch` action and 1–12 step union for create, update, reschedule, and goal linking, including unique step IDs and persisted/temporary target references; verify contract tests cover every allowed and forbidden shape.
- [x] 3.2 Keep arbitrary mixed primitive arrays invalid and normalize eligible legacy create-task arrays into the batch compiler; verify existing create-task and `create_goal_plan` contract tests remain green.
- [x] 3.3 Implement a no-write batch compiler that resolves workspace-owned entities, temporary references, expected versions, scheduling definitions, and per-step summaries; verify unit tests cover forward-reference rejection, stale versions, unavailable entities, and precise step-level errors.
- [x] 3.4 Aggregate per-step disposition into one batch disposition and retain field provenance for inferred links, critical priority, habit mode, and reminder policy; verify tests show any confirm-required step makes the entire batch pending.
- [x] 3.5 Add deterministic validation that rejects memory, settings, consent, account, quiet-hours bypass, and unrelated actions inside task batches; verify the response contract separates unsupported non-task work without implying partial completion.

## 4. Atomic application, confirmation, and Undo

- [ ] 4.1 Refactor task, occurrence, reminder, goal-link, and action-journal repositories to accept a transaction-scoped database client without changing single-action behavior; verify repository contract tests and existing e2e suites.
- [x] 4.2 Implement deterministic row locking and revalidation for all persisted batch targets in stable identifier order; verify concurrent PostgreSQL tests cover stale versions without deadlock or partial writes.
- [x] 4.3 Apply the compiled batch, primitive journal events, and final action-group state in one PostgreSQL transaction; verify injected failure at every step leaves zero task, link, reminder, or journal mutations.
- [x] 4.4 Store and confirm a pending task batch as one action group, re-running ownership, version, and domain validation on confirmation; verify one confirmation applies every step or none.
- [ ] 4.5 Reconcile reminder enqueue/rebuild operations only after commit and leave failed queue side effects recoverable by reconciliation; verify e2e tests simulate enqueue failure without rolling back committed authoritative state.
- [x] 4.6 Extend Undo to reverse mixed primitive events in one transaction and reconcile reminders afterward; verify full restoration of creates, updates, reschedules, and links plus refusal when a post-batch version changed.
- [x] 4.7 Add sanitized batch error codes and user-facing step summaries while preventing message bodies and raw provider payloads from logs; verify log-capture tests and manual error presentation.

## 5. Goal selection and advice grounding

- [x] 5.1 Build deterministic goal candidates from exact owned-title matches, active persisted goals, and recent conversational goals, including an explicit ambiguity state; verify unit tests cover one match, multiple plausible goals, and cross-workspace rejection.
- [x] 5.2 Extend the AI response contract with a validated goal-analysis focus containing owned goal ID and expected version; verify structured repair rejects advice that claims to analyze a persisted goal without a valid focus.
- [x] 5.3 Update goal-analysis and prioritization prompts to name persisted tasks and distinguish facts, assumptions, and proposals; verify application tests reproduce the “wrong goal” QA case and require a focused clarification.
- [x] 5.4 Add advice-quality fixtures for maximum-three priorities, explicit deferrals, missing success criteria, capacity limits, and calibrated causal hypotheses; verify no immediate or pending action is created for advice-only requests.

## 6. Weekly planning lifecycle

- [x] 6.1 Add a versioned Zod schema and repository methods for weekly `review_state` covering outcome, capacity/energy, risks, minimum success, commitments, and conclusion request; verify invalid or old state degrades to recoverable missing coverage.
- [x] 6.2 Extend structured AI turns with review-progress evidence and merge it deterministically into review state; verify lifecycle unit tests no longer use question presence alone to decide completion.
- [x] 6.3 Implement completion rules for all required dimensions, explicit early conclusion, and clarification-limit best effort; verify the first outcome-only answer remains active and a forced conclusion labels assumptions.
- [x] 6.4 Repair or replace prose-only continuation questions before lifecycle evaluation and remove dangling optional questions from final responses; verify regression tests for hidden “если хочешь” questions and premature completion.
- [x] 6.5 Ground the final weekly plan in current tasks and occurrences, capacity, conflicts, minimum success, and existing scheduling; verify application fixtures reconcile the existing Monday outreach task and evening interview conflict.
- [x] 6.6 Add a deterministic weekly-review memory guard requiring explicit memory-specific intent and route explicitly accepted schedule changes through `task_batch`; verify transient weekly outcomes create no memory/action groups while explicit remember and accepted task changes follow normal safety rules.

## 7. Telegram presentation, documentation, and rollout controls

- [x] 7.1 Render task-batch confirmation, applied summary, precise rejection, and one Undo control in Telegram without exposing internal step IDs; verify handler contract tests and manual button/callback flow.
- [x] 7.2 Add a default-off rollout switch for task-batch generation/application and audited cancellation of incompatible pending batches; verify disabled mode preserves current single-action behavior and cancellation records an admin audit event.
- [x] 7.3 Add sanitized metrics for temporal validation reasons, structured-repair outcomes, batch conflicts, Undo failures, weekly review depth, and reminder reconciliation failures; verify logs contain identifiers/counters only.
- [x] 7.4 Update README, operator guidance, `.env.example`, and manual QA documentation for structured recurrence, batch limits, confirmation/Undo, rollout, and rollback; verify documented commands and configuration names match implementation.

## 8. Integrated verification and release gate

- [x] 8.1 Add the production QA prompts as deterministic fixtures where possible and as an isolated provider-backed script for semantic cases; verify coverage includes complex goal plan, four-task package, fuzzy time, every-second Monday, excluded first occurrence, two reschedules, wrong-goal ambiguity, and weekly planning.
- [x] 8.2 Run `npm run check` and resolve every typecheck, build, core-test, and app-contract failure; record final test counts in the change notes.
- [x] 8.3 Run `npm run test:e2e` with migration, atomicity, workspace isolation, optimistic conflict, journaling, Undo, recurrence, and reminder assertions passing; record any environment limitation explicitly.
- [x] 8.4 Rehearse migration and rollback sequencing on a production-like database with task batches disabled, then enable recurrence, weekly lifecycle, and task batches in stages; verify existing tasks remain schedulable and new bounded series stop correctly.
- [ ] 8.5 Execute manual Telegram/provider QA on synthetic users, inspect sanitized production-like logs, Undo all mutations, and verify zero active test tasks/goals/reminders before release approval.
