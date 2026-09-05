# Design

## Context

`src/telegram/**` is the only consumer of the domain services. Handlers read `ctx.state`
(access, settings, locale), call a service, and render text plus an `InlineKeyboard`. Nothing below
`src/telegram` knows about Telegram except delivery in `TelegramService`.

That means the Mini App does not need new domain code. It needs a second presentation layer with
its own authentication, its own serialization and its own error envelope. The risk of this change is
not in the domain; it is in (a) exposing the process publicly for the first time, (b) letting many
agents edit one codebase at once.

## Decisions

### 1. Authenticate every request with raw `initData`, no session store

Each request carries `Authorization: tma <initDataRaw>`. The guard verifies the Telegram signature
(HMAC-SHA256 over the sorted `key=value` lines, key = `HMAC_SHA256("WebAppData", botToken)`),
rejects `auth_date` older than 24 h, parses `user.id`, then resolves access through
`AccessService.resolveActiveUser` exactly like the bot middleware does.

Why: no session table (so no migration), no cookie (so no CSRF and no webview cookie differences
between Telegram clients), no token refresh, and one place where identity is decided. Verification
is one HMAC per request. Stealing `initData` is equivalent to stealing a session token, so this is
not weaker than the alternative.

Rejected: signed JWT sessions — adds a secret, a refresh path and a revocation question for no gain
at this size.

The 24 h cap is a bound on *stolen* `initData`, not on revocation: a Mini App never refreshes
`initData` while it is open, and the allowlist is re-resolved on every request, so disabling a user
takes effect immediately on both surfaces. Shortening the cap only forces relaunches. Rotating the
bot token invalidates every outstanding `initData` at once, which is the emergency lever.

Four ways the implementation goes wrong, none of them obvious from the spec:

- `signature` (Bot API 8.0+, the Ed25519 field for third-party validators) **is part of the
  data-check string**; only `hash` is excluded. The third-party recipe excludes both. An agent that
  copies the wrong one sees every real client fail, and the plausible "fix" is to loosen the check.
- `timingSafeEqual` throws on a length mismatch, which turns into a 500 and a distinguishable
  response. Validate 64 lowercase hex first.
- `user` must be read from the same verified map, and its absence is a refusal. Telegram sends empty
  `initData` for keyboard-button and inline launches; there is no fallback to `initDataUnsafe`, a
  body field or a header.
- `start_param` and the URL fragment are attacker-influenced whenever a link is shared. They are
  routing hints; server scoping already turns a foreign id into a not-found.

### 2. The API is a presentation layer, never a second domain

A controller may call services and map their result to a DTO. It may not contain scheduling,
recurrence, validation or journaling logic. Anything the Telegram handler computes inline that the
web needs too moves into `src/core/` first, so both surfaces read the same function. Reviewers
should reject any `src/api/**` file that imports `drizzle-orm` or touches a repository directly.

### 3. A chat turn is asynchronous, identified by a client turn id

`ChatService.processText` can take up to 45 s. `POST /api/v1/chat/turns` returns `202` with a
`turnId` the client generated; the client polls `GET /api/v1/chat/turns/:id` (1.5 s) until it is
`done` or `failed`.

Two constraints make this more than a queue:

`processText` today requires `telegramChatId` and `telegramMessageId`. They are not decoration —
they are the idempotency key behind `messages_workspace_chat_message_uq`, and `saveOnce` returns
`message: null` on conflict. A web turn has neither. So the client turn id becomes that key: a
nullable `client_turn_id` on `messages`, unique per workspace, generated per turn and reused on
retry. Without it a POST retried after a webview timeout spends a second model call — the exact
thing this decision exists to prevent.

Recovery after a restart resolves the turn by `(workspaceId, userId, turnId)`. The tempting shortcut,
`findLastAssistantMessage`, can return a *Telegram* turn's reply, including a different pending
confirmation card — a mutation-integrity failure, not a cosmetic one.

The in-memory map stores settled outcomes, never bare promises. `main.ts` escalates any
`unhandledRejection` to SIGTERM, so one rejected model call on a promise nobody has polled yet
restarts the process, taking long polling, in-flight reminder delivery and the in-memory rate
limiter with it.

Rejected: a blocking POST — Telegram's webview and Caddy both time out earlier than the model does,
and a retry would spend a second model call.

### 4. A turn result is JSON, not rendered text

`ChatProcessResult` is serialized to `{ reply, pending?, applied?, issues[] }`, where `pending` is
the confirmation group (id, title, per-action descriptions, warnings) and `applied` is the applied
report. Confirm, cancel and undo are `POST /api/v1/action-groups/:id/{confirm,cancel,undo}` and
return the same shape. The Telegram renderer keeps its own formatting; only `describeAction` and
`renderAppliedReport` are shared.

### 5. Static hosting inside the same process, TLS in Caddy

`Dockerfile` gains a web build stage; Nest serves `web/dist` under `/app` (hashed assets immutable,
`index.html` `no-store`). Caddy terminates TLS for the domain, proxies `/app` and `/api` to
`app:3000`, and refuses `/health` and `/ready` from outside. The container binds `HOST=0.0.0.0`;
the VPS firewall opens 80/443 only, and 3000 stays unpublished.

### 6. Client i18n is its own dictionary

`web/src/i18n/{ru,uk,en}.ts` mirror the keys the app needs. Server copy is not imported into the
browser bundle. Language resolution repeats the server rule: pinned language, else Telegram
`language_code`, else English.

### 7. Rollout is flag-gated

`WEBAPP_ENABLED` (default off) mounts the API and static files. `WEBAPP_ONLY` (default off) turns
the bot's screen commands into launch buttons. Both default off means every group can merge to
`main` without changing production behaviour, and the switch is one deploy.

### 8. The IP rate limiter only works if the proxy hop is trusted

Behind `reverse_proxy app:3000`, Express sees Caddy's container address for every request. An IP
limiter keyed on that is either useless or, worse, a way for an unauthenticated attacker to fill the
single bucket and lock out the only legitimate user. `main.ts` sets `trust proxy` to the compose
network hop, and the limiter keys on `req.ip`. Caddy is safe on its side: since 2.5 it discards a
client-supplied `X-Forwarded-For` unless the client is in `trusted_proxies`.

Order matters as much as the key: IP limiter, then HMAC (cheap, no database), then
`resolveActiveUser`, then the per-user limiter. Unsigned input must never reach PostgreSQL.

### 9. Telegram Web runs the app in an iframe

`X-Frame-Options: DENY` — the default line in every "security headers" snippet — makes the app a
blank page on web.telegram.org, and the fast fix under pressure is deleting the CSP. Use
`frame-ancestors https://web.telegram.org https://*.telegram.org` and no `X-Frame-Options`. Keep
`script-src` free of `'unsafe-inline'`: the API is same-origin with no cookie, so an XSS in the app
is full account control.

## Parallelization

The rule from `AGENTS.md` holds: no two writing agents share a file. Group 0 lands first and freezes
the contract; groups 1–9 then run in parallel; group 10 merges last.

| # | Group | Owns (nobody else writes here) |
|---|---|---|
| 0 | Contract and skeleton | `src/api/contracts/**`, `src/api/api.module.ts`, `src/api/http/**`, `src/app.module.ts`, `src/main.ts`, `src/config.ts`, `.env.example`, `web/` skeleton (`index.html`, `vite.config.ts`, `tsconfig.json`, `src/api/client.ts`, `src/mocks/**`), root `package.json` |
| 1 | initData auth | `src/api/auth/**`, `tests/app/webapp-auth.test.mjs` |
| 2 | Tasks API | `src/api/tasks/**`, `tests/app/webapp-tasks.test.mjs` |
| 3 | Reminders, settings, onboarding API | `src/api/reminders/**`, `src/api/settings/**`, `tests/app/webapp-settings.test.mjs` |
| 4 | Chat API | `src/api/chat/**`, `tests/app/webapp-chat.test.mjs`, `migrations/`, `src/database/schema.ts` |
| 5 | Web shell, theming, i18n | `web/src/app/**`, `web/src/ui/**`, `web/src/i18n/**` |
| 6 | Web task screens | `web/src/screens/tasks/**` |
| 7 | Web chat screen | `web/src/screens/chat/**` |
| 8 | Web reminders, settings, onboarding | `web/src/screens/reminders/**`, `web/src/screens/settings/**`, `web/src/screens/onboarding/**` |
| 9 | Infrastructure and deploy | `Caddyfile`, `docker-compose.yml`, `Dockerfile`, `.github/workflows/**`, `docs/DEPLOYMENT.md` |
| 10 | Bot reduction and launch buttons | `src/telegram/**` |

Contract dependency: groups 5–8 build against `web/src/mocks/**` from group 0 and never wait for a
backend group. Groups 2–4 build against the same zod schemas. If a group needs a contract change,
it does not edit the contract — it asks group 0's owner, because a silent DTO change breaks a
frontend agent that is already coding against it.

Backend groups 2–4 each add their controller to their own module file; group 0's `api.module.ts`
imports all four from the start with empty placeholder modules, so nobody edits it later.

## Risks

- **Public exposure.** The allowlist now depends on one signature check. It needs its own test file
  (bad signature, tampered field, `signature` present, absent `user`, stale `auth_date`, unknown
  user, disabled user, deletion-pending user) and the layered limiter from decision 8.
- **Bounds Telegram used to provide.** Message length and voice duration are enforced by Telegram
  today and by nothing on the web. The contract caps text at 4096 characters, multer caps the upload
  by bytes, and a client-declared duration is advisory.
- **Two surfaces, one journal.** A state change made in the app must journal exactly like the same
  change from a button, or Undo lies. Every write endpoint goes through `ActionsService`/
  `TasksService`, never through a repository.
- **Copy drift.** Three languages in two places. Until the bot is reduced, a string change has to be
  made twice; group 10 is what ends that.
- **Contract churn.** The most likely way this plan fails is group 0 shipping a contract that is too
  thin, and four agents extending it independently. Group 0's deliverable is the full DTO set for
  every screen, even where the endpoint is still a stub.
