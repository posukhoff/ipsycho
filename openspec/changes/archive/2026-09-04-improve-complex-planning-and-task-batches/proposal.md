> **Superseded (2026-09-04) by the agent contract v2** described in `docs/AGENT_FLOW.md`. The task-batch mechanism and its `TASK_BATCH_ENABLED` flag are removed: an array of actions in one message is itself the atomic package, and every action addresses a task by a short context id while the server resolves the occurrence, the series and the versions. The recurrence, goal-guidance and weekly-planning behaviours below remain in force; the parts describing `task_batch`, `source`/`confidence`, `goalAnalysisFocus` and `reviewProgress` do not.

## Why

Production QA showed that IPsycho can create an atomic goal with several tasks and handle simple conversational dates, but it can silently lose recurrence end bounds, terminate weekly planning before collecting enough context, analyze the wrong goal, and reject multi-step task requests with a generic error. These failures undermine trust precisely when a user needs the assistant to turn an unclear objective into a reliable plan.

## What Changes

- Preserve the full scheduling meaning of natural-language requests, including recurrence interval and end bounds, and refuse or clarify unsupported recurrence exceptions without creating an approximation.
- Normalize AI-produced timestamps into the declared IANA timezone before deterministic validation, while still rejecting instants whose local meaning conflicts with the user request.
- Introduce an atomic task-only batch for bounded combinations of task creation, update, reschedule, and goal linking, with whole-batch validation, one confirmation disposition, one journal group, and one truthful Undo.
- Keep memory, settings, provider consent, destructive actions, quiet-hours bypass, and unrelated entity mutations outside task batches.
- Make unsupported or invalid packages produce a precise explanation of what cannot be applied and ensure no partial mutation occurs.
- Ground goal advice in an explicitly selected persisted goal; ask a focused clarification when the referenced goal is ambiguous.
- Keep a weekly planning review active until the required planning dimensions are covered or the user explicitly ends it, then return a concrete plan tied to existing tasks, capacity, conflicts, minimum success, and proposed changes.
- Prevent weekly-review discussion from being silently saved as durable profile memory unless the user explicitly asks to remember it.
- Add deterministic and provider-backed regression scenarios for complex goal plans, colloquial time, recurrence bounds, multiple task mutations, goal ambiguity, and weekly planning.

Non-goals:

- General-purpose transactions across tasks, profile memory, settings, consent, or arbitrary future action types.
- Automatic calendar optimization or autonomous rescheduling without explicit confirmation.
- Full RFC 5545 recurrence support; only product-supported recurrence forms and explicitly designed exceptions are in scope.
- Replacing deterministic validation with prompt-only safeguards.

## Capabilities

### New Capabilities

- `task-planning`: Faithful natural-language task scheduling, bounded atomic task batches, confirmation, journaling, and truthful Undo.
- `goal-guidance`: Persisted-goal selection and context-grounded analysis, prioritization, and recommendations.
- `weekly-planning`: Multi-turn weekly review lifecycle, capacity-aware planning, conflict reporting, and mutation safety.

### Modified Capabilities

None; this repository does not yet contain main OpenSpec capability specifications.

## Impact

- AI action contracts and prompts in `src/ai/` and `src/core/ai-actions.ts`.
- Task/action conversion, validation, application, journaling, and Undo in `src/actions/`, `src/tasks/`, and recurrence/time logic in `src/core/`.
- Conversation and review lifecycle in `src/chat/`, `src/context/`, and weekly briefing integration.
- PostgreSQL schema may require an append-only migration for batch step references or recurrence series bounds.
- Existing Telegram commands remain compatible; user-visible changes are better clarification, atomic task packages, accurate recurrence, and more complete weekly plans.
- Verification requires `npm run check`, `npm run test:e2e`, structured provider tests, and a manual Telegram/provider production-like gate.
