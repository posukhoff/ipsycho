# IPsycho

IPsycho is a private Telegram assistant for tasks, reminders, goals and conversations about avoidance. The chat is the main interface: a user can describe the desired result in natural language, while the application keeps authorization, validation and persistence deterministic.

Current package version: `1.0.0-rc.4`. The product contract is defined by [Implementation Baseline v10](docs/Implementation_Baseline_v10.pdf).

## Capabilities

- Private, allowlisted multi-user bot with isolated workspaces.
- Tasks and events with structured local point, window, date-only, deadline and fuzzy scheduling; checklists, importance, next actions and optimistic versions.
- Daily, weekly and monthly recurrence with timezone/DST-aware materialization, optional inclusive end date and finite excluded local dates; occurrence-level start, completion, skip, cancel, reschedule, Seen and blocker states.
- Durable reminders, quiet hours, snooze, escalation, morning/evening digests and weekly reviews.
- Goals, task-goal links, conversational topics, profile context and PostgreSQL full-text memory.
- OpenAI, Gemini and DeepSeek adapters with one explicitly configured active provider and no automatic cross-provider fallback.
- Bounded OpenAI voice transcription and multilingual RU/UK/EN AI contracts.
- Recoverable account deletion, AI suspend/enable controls, encrypted PostgreSQL backups and a Docker Compose deployment path.

## Chat control model

Ordinary natural-language messages go to the agent. The agent answers with nine kinds of action, every one addressed to an entity by the short id the context assigned this turn (`t1`, `g2`, `m3`):

- `create_task`, `update_task`, `set_task_state` (done, started, seen with an optional blocker note, skipped, cancelled), `reschedule`, `set_reminder`;
- `goal` (create, update, link, unlink) and `plan` (a new goal with its first tasks);
- `memory` (save, update, delete) and `settings` (timezone, language, digests, weekly review, quiet hours, snooze, reminder defaults).

The action names only the task; the server decides whether it means the current occurrence, the whole series (`scope`) or the task itself. Time is one `when` shape (exact, date-only day, deadline, fuzzy horizon with a review day) in the user's timezone; ids, versions and the current occurrence are resolved on the server.

The model marks each action `intent: explicit` (the user asked for exactly this, or accepted a proposal) or `intent: inferred` (the model proposes it). The server computes the risk from the action alone: explicit reversible changes are applied immediately with a 24-hour Undo; inferred changes, and always-confirm changes (cancel, skip, critical importance, habit mode, quiet-hours bypass, sensitive memory, memory edits and deletion, goal cancellation) wait for one confirmation card. All actions of one message are one package: one card or one applied group, committed in one transaction, undone as a whole.

One user message is one model call; a malformed structured output is repaired once inside the provider. A domain or reference failure is answered deterministically with what the user can change, never by a second model call. A bare "да"/"нет" answers the confirmation card the bot sent last; any other message goes to the model, which sees the still-open proposal in its context.

Buttons and commands remain deterministic shortcuts and recovery paths. The agent cannot change operator configuration, provider keys/models, allowlists or deployment state; invite users; revoke consent; or access another workspace. Account deletion/restoration and other high-impact account operations stay behind dedicated deterministic flows.

## Safety and reliability

- AI output is treated as untrusted input and must pass structured parsing, Zod validation, workspace ownership checks, optimistic-version checks and domain rules.
- State changes and their action journal are committed in the same PostgreSQL transaction where supported.
- Sensitive memory requires explicit confirmation and is not sent to an external provider as retrieved context.
- Provider consent is checked at the provider boundary, including retries and voice transcription.
- Reminder state is rechecked at delivery time; durable jobs are reconciled after restart.
- Logs contain identifiers, counters and sanitized error identity, not message bodies or raw provider payloads.
- A PostgreSQL advisory lock enforces the supported single-app-process architecture and serializes migrations.

Telegram delivery is an external side effect: a state change can commit even if the final acknowledgement is not delivered, and an ambiguous network failure can cause a resend. Closing that gap completely requires a durable Telegram inbox/outbox design.

## Local development

Requires Node.js 24+, Docker and Docker Compose.

```sh
cp .env.example .env
# Set POSTGRES_PASSWORD, TELEGRAM_BOT_TOKEN, AI_PROVIDER, AI_MODEL and the active provider key.
docker compose up -d postgres
npm install
npm run migrate
npm run admin -- users:add <telegram_user_id>
npm run dev
```

`AI_MODEL` intentionally has no default. Set `AI_PRICING_JSON` when monetary usage warnings must be meaningful. With `AI_PROVIDER=openai`, voice messages use `AI_TRANSCRIPTION_MODEL` (default `gpt-4o-mini-transcribe`); audio remains in memory only for transcription.

## Verification

```sh
npm run check       # typecheck, build, core tests and app contract tests
npm run test:e2e    # all migrations plus PostgreSQL action/integrity tests
npm audit
```

Checks that require real Telegram, provider, network or production credentials are listed in [MANUAL_ACTIONS.md](MANUAL_ACTIONS.md). Deployment and backup instructions are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
