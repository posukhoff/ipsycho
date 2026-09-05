# Telegram Mini App as the primary interface

## Why

The whole product is rendered as Telegram messages: lists page eight lines at a time, a card is
edited in place, a form is a sequence of prompts, and every screen costs a round trip through
`sendMessage`. The domain (`src/tasks`, `src/actions`, `src/settings`, `src/context`, `src/chat`)
is already free of Telegram, but its only consumer is `src/telegram/**`. A Mini App gives the same
data a real UI — scrolling lists, inline editing, one screen for a task with its checklist,
goal and reminders — without changing the safety model: the same services, the same action
journal, the same confirmation and Undo.

## What Changes

- Add an HTTP API under `/api/v1` inside the existing Nest process, authenticated by Telegram
  `initData` and backed by the existing services. No new authority: the API can do exactly what a
  Telegram button can do today.
- Add a React Mini App (`web/`) served as static files by the same process behind Caddy on a real
  domain. Screens: today, tasks, task detail, reminders, goals, settings, onboarding, chat.
- Keep natural language: the app has a chat screen that calls the same `ChatService`, receives the
  same action package, and renders the same confirmation card, applied report and Undo as JSON.
- Keep the bot as the notification channel and the launcher: reminders, digests, weekly reviews and
  escalations still arrive as messages, each with a button that opens the app on the right screen.
- Reduce the bot UI behind a default-off flag (`WEBAPP_ONLY`): screens and commands become
  "open the app", `/start` and `/restore` stay deterministic.

Non-goals:

- No change to the action contract, validation, journaling, Undo or consent rules.
- No web login outside Telegram, no session store, no OAuth, no second bot.
- No multi-process deployment: the advisory lock and the single-app-process assumption stay.
- No offline mode or local write queue in the client.
- No redesign of domain behaviour; a Mini App screen that cannot be expressed with today's services
  is out of scope for this change.

## Impact

- New: `src/api/**` (controllers, presenters, initData auth), `web/**` (Vite React app),
  `Caddyfile`, a Caddy service in `docker-compose.yml`, a web build stage in `Dockerfile`.
- Changed: `src/app.module.ts` (register the API module), `src/config.ts` and `.env.example`
  (`WEBAPP_URL`, `WEBAPP_ENABLED`, `WEBAPP_ONLY`, `HOST` in the container), `docs/DEPLOYMENT.md`
  (domain, ports 80/443, certificate), `src/telegram/**` (launch buttons, later the reduction).
- Threat model changes: the process becomes reachable from the internet. Access stays allowlisted,
  but the allowlist is now enforced by an `initData` signature check on every request instead of by
  Telegram's transport. Rate limiting, sanitized errors and "never log initData" are part of this
  change.
- One append-only migration: a nullable `client_turn_id` on `messages`, unique per workspace.
  `processText` keys idempotency on the Telegram chat/message pair, which a web turn does not have,
  and turn recovery after a restart needs to resolve *this* turn rather than the last assistant
  message. Group 4 owns it and is the only group allowed to touch `migrations/` and
  `src/database/schema.ts`.
