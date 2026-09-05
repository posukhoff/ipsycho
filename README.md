# IPsycho

IPsycho is a private Telegram assistant for tasks, reminders, goals and conversations about avoidance. The chat is the main interface: a user can describe the desired result in natural language, while the application keeps authorization, validation and persistence deterministic.

Current package version: `1.0.0-rc.4`. The product contract is defined by [Implementation Baseline v10](docs/Implementation_Baseline_v10.pdf).

## Capabilities

- Private, allowlisted multi-user bot with isolated workspaces. Access is resolved once per update in one middleware; an unknown user gets the same refusal on every command and button, a group chat is told the bot is private, and a message type without a handler gets a sentence instead of silence.
- Interface in Russian, Ukrainian and English: every handler string, card, keyboard, digest, applied report and confirmation title follows the pinned or Telegram language (`src/telegram/copy/`; a key missing in one dictionary does not compile).
- Tasks and events with structured local point, window, date-only, deadline and fuzzy scheduling; checklists, importance, next actions and optimistic versions. A task described as an outcome («разобраться с налогами») comes back with its first concrete step and three to five steps inside the same task; a task that already names an act is left alone.
- Daily, weekly and monthly recurrence with timezone/DST-aware materialization, optional inclusive end date and finite excluded local dates; occurrence-level completion, skip, cancel and reschedule. A paused series keeps its own list on the task screen, because its dates are gone from every window until it is resumed.
- A pool of undated tasks, picked once a week for the coming week by tapping, and given a day from the morning card by one more tap. The mark is the Monday of that week, so a pick that was never taken still reads as unfinished next time.
- Durable reminders, quiet hours, snooze, escalation, a morning card with the day's plan and a weekly card with the past week and the pool.
- Goals, task-goal links, conversational topics, profile context and PostgreSQL full-text memory.
- OpenAI, Gemini and DeepSeek adapters with one explicitly configured active provider and no automatic cross-provider fallback.
- Bounded OpenAI voice transcription and multilingual RU/UK/EN AI contracts.
- Recoverable account deletion, AI suspend/enable controls, encrypted PostgreSQL backups and a Docker Compose deployment path.

## Chat control model

Ordinary natural-language messages go to the agent. The agent answers with nine kinds of action, every one addressed to an entity by the short id the context assigned this turn (`t1`, `g2`, `m3`):

- `create_task`, `update_task`, `set_task_state` (done, skipped, cancelled), `reschedule`, `set_reminder`;
- `goal` (create, update, link, unlink) and `plan` (a new goal with its first tasks);
- `memory` (save, update, delete) and `settings` (timezone, language, the morning card, the weekly card's day, quiet hours, snooze, reminder defaults).

The action names only the task; the server decides whether it means the current occurrence, the whole series (`scope`) or the task itself. Time is one `when` shape (exact, date-only day, deadline, fuzzy horizon with a review day) in the user's timezone; ids, versions and the current occurrence are resolved on the server.

The model marks each action `intent: explicit` (the user asked for exactly this, or accepted a proposal) or `intent: inferred` (the model proposes it). The server computes the risk from the action alone: explicit reversible changes are applied immediately with a 24-hour Undo; inferred changes, and always-confirm changes (cancel, skip, critical importance, quiet-hours bypass, sensitive memory, memory edits and deletion, goal cancellation) wait for one confirmation card. All actions of one message are one package: one card or one applied group, committed in one transaction, undone as a whole.

One user message is one model call; a malformed structured output is repaired once inside the provider. A domain or reference failure is answered deterministically with what the user can change, never by a second model call. A bare "да"/"нет" answers the confirmation card the bot sent last; any other message goes to the model, which sees the still-open proposal in its context.

Buttons and commands remain deterministic shortcuts and recovery paths. A button that changes task state (Done, Skip, Cancel, a quick reschedule) is journaled like the same change typed in chat and carries Undo on the card itself. The agent cannot change operator configuration, provider keys/models, allowlists or deployment state; invite users; revoke consent; or access another workspace. Account deletion/restoration and other high-impact account operations stay behind dedicated deterministic flows.

A task created in the same message can be referenced by another action as `n1`, `n2` … (the first, second … `create_task`); such references fold into the create itself. When the model names a task id the context never assigned, the reply offers the listed tasks whose titles share a word with the message.

The confirmation card the user still sees is cancelled only when a later turn answers it (the same change about the same thing) or a new proposal replaces it, and only after the new package succeeded; an unrelated command or a rejected turn leaves the card on its buttons.

First run: `/start` asks for the timezone (buttons or a typed city), then the morning card, quiet hours and the weekly card, and ends on the settings card. Consent for the AI provider is asked on the first free-text message; granting it processes that message instead of asking to retype it. A reminder card offers to repeat itself in 15 minutes or an hour without moving the task; a reminder pushed out of quiet hours says so; a critical escalation names its number and can be muted for that occurrence.

## Safety and reliability

- AI output is treated as untrusted input and must pass structured parsing, Zod validation, workspace ownership checks, optimistic-version checks and domain rules.
- State changes and their action journal are committed in the same PostgreSQL transaction where supported.
- Sensitive memory requires explicit confirmation and is not sent to an external provider as retrieved context.
- Provider consent is checked at the provider boundary, including retries and voice transcription.
- Reminder state is rechecked at delivery time; durable jobs are reconciled after restart.
- Logs contain identifiers, counters and sanitized error identity, not message bodies or raw provider payloads.
- A PostgreSQL advisory lock enforces the supported single-app-process architecture and serializes migrations.

Telegram delivery is an external side effect. For reminders and digests the outcome of a failed send is classified before any retry: a 429 waits for Telegram's `retry_after` without spending an attempt, a permanent rejection (blocked bot, unknown chat) marks the delivery `failed`, a connection that never opened is retried, and a timeout after the request left the process is recorded as `ambiguous` and never resent automatically. Chat replies are still sent without that bookkeeping, so an ambiguous failure there can still produce a resend. A message the provider could not answer is retried twice on its own; when that budget is spent the bot says so, quoting the message and offering `/retry_ai`, instead of leaving it unanswered.

Retention and health. Maintenance runs hourly in bounded batches: raw message bodies and task-event details are cleared after 90 days, the task journal (`task_events`) is deleted after 365 days, and the Telegram update ledger (`telegram_updates`) after 7 days. `GET /health` only says the process is up; `GET /ready` (the Docker healthcheck) also probes PostgreSQL with a two-second timeout and reports every periodic loop, answering 503 when a loop has not completed a tick within three of its intervals.

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
