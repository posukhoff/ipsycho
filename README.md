# IPsycho

**1.0.0-rc.4 — Telegram UX audited release candidate for Implementation Baseline v10.**

IPsycho is a closed Telegram personal manager for tasks, reminders, goals and conversational help with avoidance. PostgreSQL/domain rules are the source of truth. AI only returns structured proposals; it never writes SQL or calls Telegram directly.

## What is implemented

- Closed allowlisted multi-user bot with one private workspace per user and workspace-scoped data access.
- Tasks/events with `point | window | deadline | fuzzy`, checklists, importance, reasons/next actions and optimistic versions.
- One-time plus daily/weekly/monthly recurrence, 30-day rolling materialization, IANA timezone/DST handling, pause/resume/stop/cancel/future-series edit and miss policies.
- Occurrence lifecycle, overdue vs elapsed semantics, late completion and one-time concrete -> fuzzy replanning.
- Durable reminder rules/deliveries through pg-boss; task/event/deadline defaults, exact/relative/local-date custom reminders, quiet hours, snooze, reminder supersession, critical escalation and restart reconciliation.
- Telegram-first task UI with compact cards and button-first actions: Start, Done, Later and More; Seen remains an internal/legacy event rather than a primary button. Quick reschedule, blocker capture, series scope and optional result checks remain deterministic.
- Morning/evening digests plus deterministic weekly goal/habit review, empty-briefing suppression, evening required/critical decisions and optional bounded AI review.
- Hidden conversation topics with normal/analysis mode, one-question clarification, five-turn checkpoint, conclude/end controls and bounded raw context. Evening review has its own bounded lifecycle and no longer masquerades as a synthetic Telegram user message.
- Goals, task-goal links, PostgreSQL FTS memory, sensitive-memory confirmation and 90-day raw/topic-detail retention.
- Avoidance signals from repeated reschedules/Seen/ignored checks and one non-shaming 2–10 minute return-to-action step.
- Provider-neutral AI boundary with OpenAI, Gemini and DeepSeek adapters; exactly one active provider, optional deeper model, provider-specific consent and no automatic cross-provider fallback. OpenAI voice transcription is bounded to 5 minutes/20 MB and rechecks consent at the provider boundary.
- Structured AI actions for create/update/complete/reschedule tasks, goals, memory, task-goal links, reminders and recurring series.
- Explicit reversible actions apply immediately with 24-hour Undo; inferred/risky actions require confirmation. Multi-task creation is atomic: if one item needs confirmation, the whole batch waits.
- Durable AI outage/retry policy with at most three high-level attempts, one structured-output repair attempt, usage/cost accounting, per-user rate controls and monthly spend warnings when operator pricing is configured.
- 14-day recoverable account deletion, AI suspend/enable CLI, encrypted PostgreSQL backup/restore scripts, internal-only PostgreSQL and `/health` in Docker Compose.
- Logs contain IDs/counters and sanitized error identity only, not user message/error payload text.
- The documented single-app-process architecture is enforced with a PostgreSQL advisory lock; migrations are also serialized and refuse to run while the app lock is held.

No vector database, Redis, event bus, CQRS, Google Calendar, files, public signup or shared-workspace layer is pre-built.

## Checks performed in the audit environment

```text
Core tests:                 126 / 126 passed
Whole-tree TS parse/emit:   90 / 90 files passed
Shell syntax:               passed
Relative imports missing:   0
Import cycles:              0
TODO/FIXME/HACK markers:    0 source/test markers
Source:                     90 TS files / 11,278 lines
```

The audit environment has Node.js 22 while the project requires Node.js 24+, and a clean npm dependency install could not complete because the required registry packages were unavailable from this environment. Therefore a dependency-aware semantic `npm run typecheck`, `npm run build`, `npm audit`, real PostgreSQL migrations and real Telegram/provider conformance remain **release gates**. Dependency-independent TypeScript parsing, the core TypeScript build and deterministic core tests are verified here. See `MANUAL_ACTIONS.md`.

## UX changes in rc.4

The rc.4 pass deliberately changes Telegram presentation/orchestration rather than the task domain model:

- `/today` is the primary compact day screen with one highlighted next action and navigation to tasks/reminders/settings;
- `/tasks`, `/reminders`, `/today` and `/settings` behave like Telegram-native screens and edit the current message when reached through inline navigation;
- task/reminder cards expose only the common actions (`Начать`, `Готово`, `Позже`, `•••`) instead of showing the full state machine at once;
- started tasks keep `Готово`, `Позже`, `Застрял` visible while result-check scheduling is tucked under `••• → Проверить`;
- quick reschedule supports `+1 час`, `Вечером`, `Завтра` and custom input while preserving point/window/deadline semantics and date-only schedules;
- required/critical or repeatedly postponed work still asks for a reason, but through a short second-step keyboard instead of failing the quick action;
- reschedule Undo is attached to the updated task card rather than emitted as an extra chat message;
- task completion/start/reschedule, reminder cancellation and screen navigation prefer edit-in-place plus Telegram callback toasts to reduce chat clutter;
- morning/evening briefings are shorter and bounded; morning links directly to the Today screen;
- evening AI review renders explicit `1/3`, `2/3`, `3/3` progress and a `готово` state, with a single `Закончить разбор` escape action;
- normal AI replies are compacted for Telegram, while voice transcription reuses one status message instead of producing multiple technical messages;
- Telegram callback payloads were checked against the 64-byte Bot API limit; long reschedule-reason payloads use compact internal codes;
- `/tasks` uses the Telegram-specific task query and merges concrete/fuzzy work by importance and urgency before rendering;
- nine additional focused core tests cover rc.4 quick-reschedule/review-presentation policy; the complete deterministic suite is now 126 tests.

No Redis, Mini App, CQRS, event bus or generic UI workflow framework was introduced. Detailed findings and the remaining real-environment gates are in `AUDIT_1.0.0-rc.4.md`.

## Accepted residual architecture trade-offs

- Telegram inbound dedupe records an update before the handler finishes. A crash in that narrow window can lose that update. Eliminating it requires a durable inbox/processed-state design rather than a local patch.
- Telegram delivery cannot be mathematically exactly-once: a send can reach Telegram and the process can fail before the corresponding DB `sent` update. Recovery may resend. This is an external dual-write limitation.
- AI actions are committed before the final user-facing Telegram reply. If that reply fails, state may be correct while the user misses the acknowledgement/buttons. A generic durable outbound response outbox would close this gap, but it is intentionally not introduced without real PostgreSQL/Telegram integration tests.
- A few migration-only FKs are not represented in `schema.ts` because of circular declaration order; raw SQL migrations are authoritative. This is documented to prevent schema drift mistakes.
- Telegram command/task routing remains the largest handler (~1,100 lines), while voice/review and reply rendering are isolated. rc.4 intentionally avoids another handler split during a presentation-only pass; the next split should be driven by a concrete new command family or integration test pain, not file length alone.

## Local run

Requires **Node.js 24+**.

```bash
cp .env.example .env
# Replace POSTGRES_PASSWORD, Telegram token, provider model/key and other placeholders.
docker compose up -d postgres
npm install
npm run migrate
npm run admin -- users:add <telegram_user_id>
npm run dev
```

Useful checks before the first real bot run:

```bash
npm run check
npm run build
npm audit
```

The Dockerfile automatically uses `npm ci` once a `package-lock.json` exists. `AI_MODEL` is required and intentionally has no hard-coded default. Configure `AI_PRICING_JSON` if cost warnings must have monetary meaning.

When `AI_PROVIDER=openai`, the bot also accepts voice messages and transcribes them with `AI_TRANSCRIPTION_MODEL` (default: `gpt-4o-mini-transcribe`). Audio is kept only in memory while it is transcribed; the resulting text follows the normal message-retention policy.

## Operating rules

1. AI output is untrusted until structured parsing + Zod/domain validation passes.
2. User-owned targets are resolved and mutated inside workspace scope; user scope is added where the operation is user-specific.
3. Permanent sensitive memory requires explicit confirmation.
4. Current topic history is bounded; long-term retrieval uses confirmed memory/goal/task context plus PostgreSQL FTS.
5. Quiet hours and user/account state are rechecked at delivery time.
6. Provider changes are global operator configuration and require provider-specific consent before free-text processing; consent is rechecked at the provider boundary.
7. Exactly one app process may own a PostgreSQL database. Stop the app before running migrations.
8. Prefer direct application services and database constraints over generic frameworks.

Normative product specification: `docs/Implementation_Baseline_v10.pdf`.

Checks that require a real external environment are intentionally kept in `MANUAL_ACTIONS.md`.
