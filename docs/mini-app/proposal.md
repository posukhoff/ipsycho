# Conversation in the chat, browsing in a Mini App

## Why

The product renders two competing control models over the same data. Free text goes to the agent;
the same change is also reachable through a tree of inline keyboards — `nav:`, `tsk:`, `grp:`,
`view:`, `gl:`, `wk:`, `prefs:` — that pages eight lines at a time, edits a message in place and
asks for a value with a prompt. Both paths must journal identically, carry Undo identically and
exist in three dictionaries. `src/telegram/**` is 5 032 lines, and most of it is a UI toolkit
Telegram was never meant to host.

Inline keyboards are bad at exactly one thing: browsing. They are the best thing Telegram offers
for the other thing — reacting to a push. A reminder that arrives at 19:00 with «Готово / +1 час /
Завтра» is one tap; the same reminder that says «открой приложение» is four, at the moment the user
is least willing to spend them.

So the split is not «cards versus chat». It is **reaction versus browsing**.

## What Changes

The bot keeps three jobs and loses one.

Keeps:

- **The conversation.** Free text and voice still go to `ChatService`, unchanged. This is the
  product's centre and it does not move.
- **Reaction cards.** The confirmation card (`act:confirm`/`act:cancel`), Undo (`act:undo`), the
  reminder card (done, snooze, +1 h, evening, tomorrow, skip, mute) and the consent cards. Each is
  the answer to a message the bot just sent, and each is at most six buttons about that one thing.
- **The deterministic gates.** `/start` onboarding, `/delete_account`, `/restore`, `/ai_revoke`,
  `/status`, `/retry_ai`, `/cancel`, `/invite`.

Loses: every browsing screen. `/tasks`, `/today`, `/week`, `/goals`, `/reminders`, `/settings`,
`/memory`, `/context`, the seven settings commands, and the whole `nav:` footer with the screens
behind it. They move to a Mini App with real lists, one screen per task, and forms that are forms.

Digests stay in chat as text — they are pushes — with one `web_app` button each. The weekly card
keeps its goal-step buttons, because a step proposal is a conversation turn, not a screen.

Non-goals:

- **No chat screen in the Mini App.** The app opens _inside_ the chat and closing it returns the
  user to the conversation; a second chat surface would duplicate the turn lifecycle, the pending
  card and Undo for a swipe's worth of convenience. This drops the `client_turn_id` migration, the
  async turn polling, the in-memory turn map and the multipart voice endpoint — the four riskiest
  items in the previous version of this plan. If it is wanted later it is an additive change.
- No change to the action contract, validation, journaling, Undo or consent rules.
- No onboarding in the app: `/start` is the bootstrap that has to work before the app has ever been
  opened, and it is the fallback when the app is unreachable. It stays in chat as it is.
- No web login outside Telegram, no session store, no OAuth, no second bot.
- No multi-process deployment: the advisory lock and the single-app-process assumption stay.
- No offline mode or local write queue in the client.
- No migration. If a group believes it needs one, that is a contract discussion, not a commit.

## Impact

- New: `src/api/**` (controllers, presenters, initData auth), `web/**` (Vite + React),
  `Caddyfile`, a Caddy service in `docker-compose.yml`, a web build stage in `Dockerfile`.
- Changed: `src/app.module.ts`, `src/main.ts`, `src/config.ts` and `.env.example`
  (`WEBAPP_ENABLED`, `WEBAPP_URL`, `HOST`), `docs/DEPLOYMENT.md`, `MANUAL_ACTIONS.md`.
- Removed, in a separate change that ships after the app is verified in production:
  `src/telegram/handlers/screens.service.ts`, `handlers/week-callbacks.service.ts`, most of
  `telegram-screens.ts` and `telegram-keyboards.ts`, the browsing halves of
  `system-commands.service.ts` and `settings-commands.service.ts`, their copy keys in all three
  dictionaries, and their tests. The inventory is in `tasks.md` § 11 and is exhaustive on purpose:
  a half-deleted screen tree is worse than either end state.
- Threat model changes: the process becomes reachable from the internet. Access stays allowlisted,
  but the allowlist is now enforced by an `initData` signature check on every request instead of by
  Telegram's transport. Rate limiting, sanitized errors and "never log initData" are part of this
  change.
