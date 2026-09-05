# Tasks

Group 0 lands first. Groups 1–9 run in parallel after it. Group 10 merges last.
Every group ends with `npm run check`; web groups also with `npm -w web run build`.

Items marked **[sec]** come from the security review of this plan; the reasoning is in
`design.md` under the decision they belong to.

## 0. Contract and skeleton (blocking, one agent)

- [ ] 0.1 Add `src/api/contracts/` with zod schemas and inferred types for every screen: task list row and group, task detail, occurrence state change, reschedule, checklist, reminder row, settings, onboarding step, goal, chat turn, pending action group, applied report, error envelope. Cover screens whose endpoint is still a stub.
- [ ] 0.2 **[sec]** Add `src/api/http/`: a zod validation pipe, an exception filter producing `{ error: { code, message, details? } }` with sanitized codes only — `details` never echoes request input — and a `/api/v1` route prefix.
- [ ] 0.3 **[sec]** Add `src/api/api.module.ts` importing four placeholder modules (`auth`, `tasks`, `reminders+settings`, `chat`), each an empty Nest module owned by its group. Register it in `src/app.module.ts` behind `WEBAPP_ENABLED`; the flag must unmount the static files as well as the API.
- [ ] 0.4 Add `WEBAPP_ENABLED`, `WEBAPP_ONLY`, `WEBAPP_URL` to `src/config.ts` and `.env.example`; `WEBAPP_URL` is required when `WEBAPP_ENABLED=true`.
- [ ] 0.5 **[sec]** In `main.ts`: `app.set("trust proxy", …)` for the compose network hop only, an explicit JSON body limit of 64 KB, and no `enableCors()` — the app is same-origin and sends no cookies. Group 0 owns `main.ts`; no other group edits it.
- [ ] 0.6 Scaffold `web/` (Vite + React + TS, npm workspace): `index.html`, `vite.config.ts` with base `/app/`, tsconfig, eslint/prettier wired into the root scripts, a typed `web/src/api/client.ts` generated from the contracts, and `web/src/mocks/**` returning realistic fixtures for every endpoint under `VITE_API_MOCK=1`.
- [ ] 0.7 **[sec]** Keep every `web` dependency in `devDependencies` (or run the runtime install with `--workspaces=false`) so the production image and `npm audit --omit=dev` stay meaningful.
- [ ] 0.8 Add root scripts `dev:web`, `build:web`, and include `web` in `npm run check` (typecheck, lint, build). Verify a mock-mode `npm -w web run dev` renders a blank shell against fixtures with no backend running.

## 1. initData authentication

- [ ] 1.1 Implement `verifyInitData(raw, botToken, now)` in `src/core/` as a pure function: URL-decoded values from `URLSearchParams`, sorted by key, joined with `\n`, key = `HMAC_SHA256("WebAppData", botToken)`, `auth_date` max age 24 h. Exclude **only** `hash` from the data-check string — `signature` is part of it. One algorithm, no Ed25519 fallback. Validate the `hash` is 64 lowercase hex before `timingSafeEqual`, which throws on a length mismatch.
- [ ] 1.2 **[sec]** Unit tests for `verifyInitData`: valid sample; payload containing `signature`; tampered field; reordered payload; missing `hash`; wrong-length `hash`; duplicated key; non-ASCII name; stale `auth_date`; **absent `user`** (Telegram sends empty initData for keyboard-button and inline launches — that is a refusal, never a fallback to `initDataUnsafe`, a body field or a header).
- [ ] 1.3 Add a Nest guard resolving the user through `AccessService.resolveActiveUser` and attaching `{ access, settings, locale }` the way the bot middleware does. Unknown, disabled and deletion-pending users get one identical refusal with no enumeration.
- [ ] 1.4 **[sec]** Rate limiting in this order: IP limiter (keyed on `req.ip`, correct only with 0.5), then the HMAC check, then `resolveActiveUser`, then the per-user limiter. Unsigned input must never reach PostgreSQL. The limiter is in memory and resets on restart — a deliberate choice at this size, since the AI spend limits are already database-backed.
- [ ] 1.5 **[sec]** Logging: the guard throws fixed-string errors only; log context is `{ requestId, userId }` with the internal uuid, never the Telegram user object. Test by capturing stdout and stderr across a rejected and a failed authenticated request and asserting none of `hash=`, `auth_date=`, `first_name` appear. `safeError` keeps 300 characters of a message and does not know these keys, so an interpolated raw `initData` would leak in full.
- [ ] 1.6 Add `GET /api/v1/me` returning access state, settings, locale, AI/consent state and the onboarding step, so the client has one bootstrap call.

## 2. Tasks API

- [ ] 2.1 `GET /tasks` (scope, page), `GET /tasks/today`, `GET /tasks/:id` — from `TasksService.listGroupedForTelegram`, `listTodayGroupedForTelegram`, `getTask`, `getTaskCardExtras`, mapped to the contracts. Rename the shared read paths off their `ForTelegram` names if they now serve both surfaces.
- [ ] 2.2 `POST /tasks/:id/state` (done, started, seen with blocker note, skipped, cancelled) through `TasksService.setOccurrenceStatus`, journaled with Undo exactly like the button.
- [ ] 2.3 `POST /tasks/:id/reschedule` including the reason requirement from `isRescheduleReasonRequired`, and the quick-reschedule presets the callbacks expose today.
- [ ] 2.4 `POST /tasks`, `PATCH /tasks/:id` and checklist writes through `ActionsService` with optimistic versions; a stale version returns a typed conflict the client can show.
- [ ] 2.5 Goals: `GET /goals`, `GET /goals/:id`, link/unlink, mirroring the goal screens.
- [ ] 2.6 App contract tests: workspace isolation on every read, version conflict, journal row written, Undo restores.

## 3. Reminders, settings, onboarding API

- [ ] 3.1 `GET /reminders` (upcoming, paged) and `POST /reminders/:deliveryId/{snooze,repeat}` matching the reminder card's options.
- [ ] 3.2 `GET /settings` and `PATCH /settings` for timezone, language, digests, weekly review, quiet hours, snooze and reminder defaults, validated by the same domain rules the settings commands use.
- [ ] 3.3 Onboarding: `GET /onboarding` (current step) and `POST /onboarding/:step`, reproducing the `/start` sequence — timezone, digests, quiet hours, weekly review — and ending on the settings screen.
- [ ] 3.4 Consent: `POST /consent/{grant,revoke}` and voice consent. This is a pre-check on top of the boundary check inside `ChatService` and `TranscriptionService`, which stays authoritative.
- [ ] 3.5 App contract tests for timezone validation, quiet-hours edges and consent gating.

## 4. Chat API

- [ ] 4.1 **[sec]** Required migration, append-only, with the Drizzle declaration in the same commit: a nullable `client_turn_id` (uuid) on `messages`, unique per `(workspace_id, client_turn_id)`, plus the link from the assistant row back to its turn. The client generates it per turn; it is both the idempotency key `saveOnce` needs (today that key is `telegramChatId`/`telegramMessageId`, which a web turn does not have) and the `turnId` the client polls. This group is the only one allowed to touch `migrations/` and `src/database/schema.ts`.
- [ ] 4.2 **[sec]** Widen `ChatService.processText` so the message identity is one of the two shapes — a Telegram chat/message pair or a client turn id — instead of two required Telegram numbers. Preserve the existing Telegram path unchanged.
- [ ] 4.3 **[sec]** `POST /chat/turns` returning `202 { turnId }`; `GET /chat/turns/:id` returning `pending | done | failed`. The in-memory map stores **settled outcomes**, not promises: attach `.then(ok, err)` at creation so the chain always has a handler, store `{ status, result | errorCode }`, and expire entries. `main.ts` turns any `unhandledRejection` into a SIGTERM, so a bare stored promise would let one failed model call restart the process, dropping long polling, in-flight reminder delivery and the rate limiter.
- [ ] 4.4 **[sec]** Resolve a turn by `(workspaceId, userId, turnId)` and nothing else, so a restart recovers *this* turn's result and never another turn's pending card — `findLastAssistantMessage` is not a valid recovery path. Cap `text` at 4096 characters in the contract, matching what Telegram enforces today.
- [ ] 4.5 Serialize `ChatProcessResult` into the contract shape (reply, pending group with per-action descriptions and warnings, applied report, issues) reusing `describeAction` and `renderAppliedReport`.
- [ ] 4.6 `POST /action-groups/:id/{confirm,cancel,undo}` through `ActionsService`, returning the same shape; expired and already-answered groups return typed states, not errors.
- [ ] 4.7 `GET /chat/history` (paged) and the conversation controls the bot has: end, pause, clear, retry.
- [ ] 4.8 **[sec]** Voice: `POST /chat/voice` (multipart) reusing `TranscriptionService`. Multer with memory storage and `limits: { fileSize: aiVoiceMaxBytes, files: 1 }`; audio never touches disk. The consent and AI-status check runs as a **guard**, which Nest executes before the interceptor that buffers the body. Client-declared duration is advisory only — the bot gets `voice.duration` from Telegram, the web does not — so `aiVoiceMaxBytes` is the hard bound.
- [ ] 4.9 App contract tests: a package proposed in the app and confirmed in the app; **a retried POST with the same turn id makes one model call**; **a turn id from another workspace returns the same not-found envelope**; **a rejecting `processText` yields a `failed` turn and emits no `unhandledRejection`**; rate limiting; AI suspended; consent missing; model failure surfaced deterministically.

## 5. Web shell, theming, i18n

- [ ] 5.1 Telegram SDK bootstrap: `ready()`, `expand()`, viewport height, theme params mapped to CSS variables, dark and light, safe-area insets.
- [ ] 5.2 Navigation with BackButton and MainButton wired to the router, plus haptics on state changes.
- [ ] 5.3 A small component set the screen groups agree on: list row, card, sheet, form field, date/time picker, empty state, error state, skeleton loader, toast, Undo snackbar.
- [ ] 5.4 `web/src/i18n/{ru,uk,en}.ts` with the resolution rule (pinned, then `language_code`, then English) and a test asserting all three dictionaries have the same keys.
- [ ] 5.5 Data layer: fetch wrapper attaching `Authorization: tma <initDataRaw>`, typed errors, retry policy, and a `useQuery`-style cache with optimistic updates for state toggles.
- [ ] 5.6 **[sec]** `start_param` / `tgWebAppStartParam` and the URL fragment are attacker-influenced whenever a link is shared. Use them for navigation only; server scoping already turns a foreign id into a not-found.

## 6. Web task screens

- [ ] 6.1 Today: grouped occurrences, inline done/start/skip with an Undo snackbar.
- [ ] 6.2 Tasks: scope tabs and counts, infinite list instead of eight-line pages, grouped repeats expanding to their dates.
- [ ] 6.3 Task detail: title, schedule, importance, checklist, goal, reminders, journal; inline edit with the version conflict path.
- [ ] 6.4 Create and edit forms covering every schedule shape — exact, window, date-only, deadline, fuzzy with a review day — plus recurrence with an end date and excluded dates.
- [ ] 6.5 Reschedule sheet with the presets and the reason field when required.
- [ ] 6.6 Goals list and detail with task links.

## 7. Web chat screen

- [ ] 7.1 Message stream from history with the polling turn lifecycle (a client-generated turn id per send, reused on retry) and a typing indicator.
- [ ] 7.2 Confirmation card: per-action lines, warnings, confirm and cancel, and the rule that an unanswered card stays visible.
- [ ] 7.3 Applied report with Undo for the whole package inside its 24 h window.
- [ ] 7.4 Issues and deterministic failures rendered as what the user can change, never a raw error.
- [ ] 7.5 Voice recording with the duration limit, plus consent and AI-suspended states.

## 8. Web reminders, settings, onboarding

- [ ] 8.1 Reminders list with snooze and repeat.
- [ ] 8.2 **[sec]** Settings: timezone (search and detect), language, digests, quiet hours, weekly review, reminder defaults, AI and consent, and the deletion request behind its deterministic confirmation. **Restore is not in the app**: the guard refuses deletion-pending users by design, exactly as the bot's allowlist gate does, and `/restore` stays a chat command. The deletion success screen says so.
- [ ] 8.3 First-run onboarding as a step flow ending on settings.

## 9. Infrastructure and deploy

- [ ] 9.1 **[sec]** Add a domain and a `Caddyfile`: TLS; two `handle` blocks (`/app*`, `/api/v1/*`) proxied to `app:3000`; a final `respond 404` and no catch-all `reverse_proxy`, because Caddy answers an unmatched path with an empty 200 and `/health` and `/ready` expose the commit SHA, database state and loop names. `admin off`. Port 80 redirects only. `request_body { max_size 64KB }` on the API, raised to 21 MB on `/api/v1/chat/voice` alone.
- [ ] 9.2 **[sec]** Headers: `Content-Security-Policy: default-src 'none'; script-src 'self' https://telegram.org; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors https://web.telegram.org https://*.telegram.org; base-uri 'none'; form-action 'none'`, plus HSTS, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. **No `X-Frame-Options`** — Telegram Web opens Mini Apps in an iframe, and `DENY` renders a blank page whose obvious "fix" is deleting the CSP. Vite emits no inline scripts; keep `script-src` free of `'unsafe-inline'`, since the API is same-origin and an XSS here is full account control. Access logs stay off, or filter away the `Authorization` header.
- [ ] 9.3 Add Caddy to `docker-compose.yml` with a certificate volume; open 80/443 in the VPS firewall; keep 3000 and 5432 unpublished (both already are).
- [ ] 9.4 Add the web build stage to `Dockerfile` and serve `web/dist` under `/app` (hashed assets immutable, `index.html` `no-store`).
- [ ] 9.5 Update the GitHub Actions deploy for the larger build and a post-deploy check that `/app` answers 200 over HTTPS.
- [ ] 9.6 Document in `docs/DEPLOYMENT.md`: DNS, certificate issuance and renewal, BotFather Mini App registration, `setChatMenuButton`, rollback with `WEBAPP_ENABLED=false`, and a **revocation** paragraph — disabling the user with the admin CLI is immediate; rotating the bot token invalidates every outstanding `initData` at once and also restarts the bot.
- [ ] 9.7 Add the manual gates to `MANUAL_ACTIONS.md`: open the app from a real client on iOS, Android, desktop **and Telegram Web in a browser** (the iframe case); check theme, back button and viewport.

## 10. Bot reduction and launch buttons (merges last)

- [ ] 10.1 Add a `web_app` launch button to reminder, digest, weekly-review and escalation messages, deep-linking to the relevant screen. Keep the id in the fragment (`${WEBAPP_URL}/#/task/<id>`) so it never reaches an access log.
- [ ] 10.2 Set the chat menu button to the Mini App at bootstrap when `WEBAPP_ENABLED=true`.
- [ ] 10.3 Behind `WEBAPP_ONLY`, replace the screen commands and callback screens with a launch button; keep `/start`, `/restore` and account operations deterministic in chat.
- [ ] 10.4 Behind the same flag, answer free text with a launch button instead of a model call, and state in the copy that the conversation lives in the app.
- [ ] 10.5 Remove the copy keys that no surface uses any more, once the flag is on in production.

## 11. Integrated verification

- [ ] 11.1 `npm run check` and `npm run test:e2e` on the merged branch; record counts.
- [ ] 11.2 One end-to-end pass with both flags off (production unchanged) and one with both on.
- [ ] 11.3 Production QA on a real device: create a task by voice in the app, confirm the package, undo it, receive the reminder in chat, open it in the app.
