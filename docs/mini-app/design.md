# Design

## Context

`src/telegram/**` is the only consumer of the domain services. Handlers read `ctx.state` (access,
settings, locale), call a service, and render text plus an `InlineKeyboard`. Nothing below
`src/telegram` knows about Telegram except delivery in `TelegramService` — and two imports of pure
text helpers (`briefing-content.service.ts` takes `todayLine`, `reminder-queue.service.ts` takes
`reminderCardText`).

So the Mini App needs no new domain code. It needs a second presentation layer with its own
authentication, serialization and error envelope. The risk is not in the domain; it is in
(a) exposing the process publicly for the first time, (b) many agents editing one codebase at once,
and (c) deleting the old surface without leaving a hole.

## Decisions

### 1. The split rule is reaction versus browsing

A button stays in the chat only if it answers the message it is attached to, in the moment that
message arrives, and the whole answer fits in about six buttons. Everything that requires reading a
list, choosing among many, or entering a value is browsing and moves to the app.

Applied:

| Surface                   | What lives there                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Chat, free text           | The agent. Create, change, reschedule, goals, memory, settings by conversation. Unchanged.                                              |
| Chat, reaction cards      | Confirmation + Undo (`act:*`), the reminder card (`occ:done`, `follow:snooze:*`, `resched:1h                                            | evening | tomorrow`, `occ:skip`, `rem:mute`), consent (`ai:_`, `voice:_`). |
| Chat, deterministic gates | `/start`, `/delete_account`, `/restore`, `/ai_revoke`, `/status`, `/retry_ai`, `/cancel`, `/invite`, `/help`, `/clear`.                 |
| Chat, pushes              | Reminder, escalation, morning card, weekly card — text plus one launch button.                                                          |
| Mini App                  | Today, tasks, task detail, create/edit, reschedule, goals, week plan and the pool, paused series, reminders, settings, memory, profile. |

The rule decides the borderline cases too. The morning card's «take today» rows are a list of eight
taps, so they go to the app. The weekly card's «предложи шаг» button asks the model and answers with
a chat proposal, so it stays: it is a conversation turn with a shortcut.

### 2. A `web_app` button is the bridge, and it carries the destination

`InlineKeyboard.webApp(label, url)` is allowed on inline keyboards in private chats, which is the
only kind this bot has. Every push and every reaction card carries one, pointing at the screen the
message is about: `${WEBAPP_URL}/#/task/<occurrenceId>`, `/#/today`, `/#/week`.

The id goes in the **fragment**, never the path or the query: a fragment is not sent to the server
and never reaches Caddy's access log or an upstream proxy.

This is also what keeps the reaction cards small. The two-step flows that used to live behind
«Ещё» and «Другая дата» — cancel, pause series, pick an arbitrary date, pick a reschedule reason
from four buttons — become one launch button that opens that occurrence's sheet in the app. The
reminder card keeps: Готово · Отложить 15 м / 1 ч · +1 ч / Вечером / Завтра · Пропустить (repeats
only) · Открыть.

`tgWebAppStartParam` exists only for `t.me/<bot>/<app>?startapp=` links, not for `web_app` buttons,
so the fragment is the mechanism for both and there is one routing path to test. Treat it as
attacker-influenced whenever a link is shared: it is a navigation hint, and server-side workspace
scoping already turns a foreign id into a not-found.

### 3. No chat screen in the Mini App

The app opens inside the chat; dismissing it puts the conversation back on screen. A second chat
surface would need its own turn identity (`processText` keys idempotency on the Telegram
chat/message pair, which a web turn does not have), an async turn lifecycle because a model call can
take 45 s while the webview and Caddy time out earlier, a restart-recovery path that resolves _this_
turn rather than the last assistant message, a settled-outcome map that cannot leak an
`unhandledRejection` into the SIGTERM handler in `main.ts`, and a multipart voice endpoint with its
own consent guard.

That is one migration and roughly a third of the plan, to save a swipe. Cut.

The consequence to accept: a change made in the app produces no chat message, and a proposal made
in chat is answered in chat. The two surfaces share the journal, not the conversation.

### 4. Authenticate every request with raw `initData`, no session store

Each request carries `Authorization: tma <initDataRaw>`. The guard verifies the Telegram signature
(HMAC-SHA256 over the sorted `key=value` lines, key = `HMAC_SHA256("WebAppData", botToken)`),
rejects `auth_date` older than 24 h, parses `user.id`, then resolves access through
`AccessService.resolveActiveUser` exactly like the bot middleware does.

Why: no session table (so no migration), no cookie (so no CSRF and no webview cookie differences
between clients), no refresh, and one place where identity is decided. Stealing `initData` is
equivalent to stealing a session token, so this is not weaker than the alternative.

The 24 h cap bounds _stolen_ `initData`, it is not revocation: a Mini App never refreshes `initData`
while open, and the allowlist is re-resolved on every request, so disabling a user takes effect
immediately on both surfaces. Rotating the bot token invalidates every outstanding `initData` at
once, which is the emergency lever.

Four ways the implementation goes wrong, none obvious from the spec:

- `signature` (Bot API 8.0+, the Ed25519 field for third-party validators) **is part of the
  data-check string**; only `hash` is excluded. The third-party recipe excludes both. An agent that
  copies the wrong one sees every real client fail, and the plausible "fix" is loosening the check.
- `timingSafeEqual` throws on a length mismatch, which becomes a 500 and a distinguishable response.
  Validate 64 lowercase hex first.
- `user` must be read from the same verified map, and its absence is a refusal. Telegram sends empty
  `initData` for keyboard-button and inline launches; there is no fallback to `initDataUnsafe`, a
  body field or a header.
- The values are already URL-decoded by `URLSearchParams`; decoding twice corrupts a name with a
  literal `%`.

### 5. The API is a presentation layer, never a second domain

A controller may call services and map the result to a DTO. It may not contain scheduling,
recurrence, validation or journaling logic. Anything a Telegram handler computes inline that the web
needs too moves into `src/core/` first, so both surfaces read the same function. Reject any
`src/api/**` file that imports `drizzle-orm` or touches a repository.

Every write goes through `ActionsService`/`TasksService` with optimistic versions, so a change made
in the app journals exactly like the same change from a button. Otherwise Undo lies.

### 6. Static hosting inside the same process, TLS in Caddy

`Dockerfile` gains a web build stage; Nest serves `web/dist` under `/app` (hashed assets immutable,
`index.html` `no-store`). Caddy terminates TLS, proxies `/app` and `/api/v1` to `app:3000`, and
refuses everything else — including `/health` and `/ready`, which expose the commit SHA, database
state and loop names. No catch-all `reverse_proxy`: Caddy answers an unmatched path with an empty 200. The container binds `HOST=0.0.0.0`; the firewall opens 80/443 and 3000 stays unpublished.

### 7. Client i18n is its own dictionary

`web/src/i18n/{ru,uk,en}.ts` mirror the keys the app needs. Server copy is not imported into the
browser bundle. Language resolution repeats the server rule: pinned language, else Telegram
`language_code`, else English. A test asserts the three dictionaries have identical key sets, the
same guarantee `src/telegram/copy/` has today.

### 8. The IP rate limiter only works if the proxy hop is trusted

Behind `reverse_proxy app:3000`, Express sees Caddy's container address for every request. A limiter
keyed on that is either useless or a way for an unauthenticated attacker to fill the single bucket
and lock out the only legitimate user. `main.ts` sets `trust proxy` to the compose network hop and
the limiter keys on `req.ip`. Caddy discards a client-supplied `X-Forwarded-For` unless the client is
in `trusted_proxies`.

Order matters as much as the key: IP limiter → HMAC (cheap, no database) → `resolveActiveUser` →
per-user limiter. Unsigned input must never reach PostgreSQL.

### 9. Telegram Web runs the app in an iframe

`X-Frame-Options: DENY` — the default line in every "security headers" snippet — makes the app a
blank page on web.telegram.org, and the fast fix under pressure is deleting the CSP. Use
`frame-ancestors https://web.telegram.org https://*.telegram.org` and no `X-Frame-Options`. Keep
`script-src` free of `'unsafe-inline'`: the API is same-origin with no cookie, so an XSS in the app
is full account control.

### 10. Three deploys, and the cleanup is the third

The dangerous ordering is deleting the bot's screens in the same release that introduces the app.

1. **Build.** `WEBAPP_ENABLED=false`. Groups 0–9 merge to `main`. Production behaviour is byte-for-
   byte unchanged, and every merge is safe on its own.
2. **Coexist.** Flag on. Launch buttons appear on pushes and cards; the menu button opens the app.
   Both surfaces work. This is where the app is used on a real iPhone, Android, desktop and
   web.telegram.org before anything is removed.
3. **Cleanup.** Only after step 2 has run for a while: group 11 deletes the browsing screens, their
   copy keys and their tests in one change. Rollback for step 3 is a revert, not a flag — a flag
   that keeps dead screens alive is how a "temporary" second control model becomes permanent.

`WEBAPP_ONLY` from the earlier draft is gone. Two flags meant four states, two of them nonsense
(bot reduced, app off).

### 11. The cleanup deletes, it does not deprecate

Every removed command answers with one sentence naming the app and a launch button, for one release
of grace — Telegram keeps old commands in the client's menu and in scroll-back. `setMyCommands` is
updated in the same change so the menu stops advertising them.

What must be deleted, not left behind: the copy keys in all three dictionaries (a stale key breaks
nothing and so is never noticed), the callback handlers (an old scroll-back button still fires, and
an unhandled `callback_query` leaves a spinner), and the tests, whose snapshots would otherwise pin
the deleted copy.

## Parallelization

The rule from `AGENTS.md` holds: no two writing agents share a file. Group 0 lands first and freezes
the contract; groups 1–9 run in parallel; group 10 needs only group 0; group 11 runs last, alone.

| #   | Group                                   | Owns (nobody else writes here)                                                                                                                                                                                                                                       |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Contract and skeleton                   | `src/api/contracts/**`, `src/api/api.module.ts`, `src/api/http/**`, `src/app.module.ts`, `src/main.ts`, `src/config.ts`, `.env.example`, `web/` skeleton (`index.html`, `vite.config.ts`, `tsconfig.json`, `src/api/client.ts`, `src/mocks/**`), root `package.json` |
| 1   | initData auth                           | `src/core/init-data.ts`, `src/api/auth/**`, `tests/core/init-data.test.mjs`, `tests/app/webapp-auth.test.mjs`                                                                                                                                                        |
| 2   | Tasks and goals API                     | `src/api/tasks/**`, `src/api/goals/**`, `tests/app/webapp-tasks.test.mjs`                                                                                                                                                                                            |
| 3   | Reminders, settings, memory API         | `src/api/reminders/**`, `src/api/settings/**`, `src/api/memory/**`, `tests/app/webapp-settings.test.mjs`                                                                                                                                                             |
| 4   | Week plan API                           | `src/api/week/**`, `tests/app/webapp-week.test.mjs`                                                                                                                                                                                                                  |
| 5   | Web shell, theming, i18n, data layer    | `web/src/app/**`, `web/src/ui/**`, `web/src/i18n/**`, `web/src/lib/**`                                                                                                                                                                                               |
| 6   | Web task and goal screens               | `web/src/screens/tasks/**`, `web/src/screens/goals/**`                                                                                                                                                                                                               |
| 7   | Web today and week screens              | `web/src/screens/today/**`, `web/src/screens/week/**`                                                                                                                                                                                                                |
| 8   | Web reminders, settings, memory screens | `web/src/screens/reminders/**`, `web/src/screens/settings/**`, `web/src/screens/memory/**`                                                                                                                                                                           |
| 9   | Infrastructure and deploy               | `Caddyfile`, `docker-compose.yml`, `Dockerfile`, `.github/workflows/**`, `docs/DEPLOYMENT.md`, `MANUAL_ACTIONS.md`                                                                                                                                                   |
| 10  | Launch buttons                          | `src/telegram/**` — additive only                                                                                                                                                                                                                                    |
| 11  | Bot cleanup                             | `src/telegram/**`, `tests/app/telegram-*.test.mjs`, `tests/app/week-callbacks.test.mjs`, `tests/app/__snapshots__/**`                                                                                                                                                |

Groups 10 and 11 own the same directory, so **one agent owns both, sequentially**: 10 merges during
step 1 of the rollout, 11 is held until step 3. No other group edits `src/telegram/**` — group 2
renaming `listGroupedForTelegram` renames the call site too, which is the one sanctioned exception,
and it must be a rename with no behaviour change.

Contract dependency: groups 5–8 build against `web/src/mocks/**` from group 0 and never wait for a
backend group. Groups 2–4 build against the same zod schemas. A group that needs a contract change
asks group 0's owner instead of editing the contract, because a silent DTO change breaks a frontend
agent already coding against it.

Backend groups 2–4 each add their controller to their own module file; group 0's `api.module.ts`
imports all of them from the start as empty placeholder modules, so nobody edits it later.

## Risks

- **Public exposure.** The allowlist now depends on one signature check. It needs its own test file
  (bad signature, tampered field, `signature` present, absent `user`, stale `auth_date`, unknown
  user, disabled user, deletion-pending user) and the layered limiter from decision 8.
- **Bounds Telegram used to provide.** Message length is enforced by Telegram today and by nothing
  on the web. The contract caps every free-text field explicitly.
- **Two surfaces, one journal.** A state change made in the app must journal exactly like the same
  change from a button, or Undo lies. Every write endpoint goes through `ActionsService`/
  `TasksService`, never a repository.
- **Copy drift during coexistence.** Three languages in two places between step 1 and step 3. This
  is the reason step 3 exists and the reason it is not optional.
- **Contract churn.** The likeliest way this plan fails is group 0 shipping a contract that is too
  thin and four agents extending it independently. Group 0's deliverable is the full DTO set for
  every screen, including screens whose endpoint is still a stub.
- **A user who never opens the app.** Onboarding, account operations and the whole conversation stay
  in chat, so the bot remains usable without ever launching the Mini App — minus browsing. That is
  the intended floor, and `/help` after the cleanup must state it plainly.
