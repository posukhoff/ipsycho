# Tasks

Group 0 lands first and freezes the contract. Groups 1–9 run in parallel after it. Group 10 is
additive and merges any time after 0. Group 11 runs alone, after the app has been used in
production (design.md § 10).

Every group ends with `npm run check`; web groups also with `npm -w web run build`.
Items marked **[sec]** come from the security review; the reasoning is in `design.md`.

## 0. Contract and skeleton (blocking, one agent)

- [ ] 0.1 Add `src/api/contracts/` with zod schemas and inferred types for **every** screen, including screens whose endpoint is still a stub: task list row and group, task detail, occurrence state change, reschedule (with the reason requirement), checklist, create/edit task covering every schedule shape, goal row and detail, week pool row, paused series row, reminder row, settings, memory row, profile, error envelope.
- [ ] 0.2 **[sec]** Add `src/api/http/`: a zod validation pipe, an exception filter producing `{ error: { code, message, details? } }` with sanitized codes only — `details` never echoes request input — and the `/api/v1` route prefix.
- [ ] 0.3 Add `src/api/api.module.ts` importing placeholder modules for `auth`, `tasks+goals`, `reminders+settings+memory` and `week`, each an empty Nest module owned by its group. Register it in `src/app.module.ts` behind `WEBAPP_ENABLED`; the flag must unmount the static files as well as the API.
- [ ] 0.4 Add `WEBAPP_ENABLED` (default false) and `WEBAPP_URL` to `src/config.ts` and `.env.example`; `WEBAPP_URL` is required when `WEBAPP_ENABLED=true`. There is no `WEBAPP_ONLY`.
- [ ] 0.5 **[sec]** In `main.ts`: `app.set("trust proxy", …)` for the compose network hop only, an explicit 64 KB JSON body limit, and no `enableCors()` — same-origin, no cookies. Group 0 owns `main.ts`.
- [ ] 0.6 Scaffold `web/` (Vite + React + TS, npm workspace): `index.html`, `vite.config.ts` with base `/app/`, tsconfig, eslint/prettier wired into the root scripts, a typed `web/src/api/client.ts` generated from the contracts, and `web/src/mocks/**` returning realistic fixtures for every endpoint under `VITE_API_MOCK=1`.
- [ ] 0.7 **[sec]** Keep every `web` dependency in `devDependencies` (or run the runtime install with `--workspaces=false`) so the production image and `npm audit --omit=dev` stay meaningful.
- [ ] 0.8 Add root scripts `dev:web`, `build:web`, and include `web` in `npm run check` (typecheck, lint, build). Verify `npm -w web run dev` in mock mode renders a shell with no backend running.

## 1. initData authentication

- [ ] 1.1 Implement `verifyInitData(raw, botToken, now)` in `src/core/init-data.ts` as a pure function: values from `URLSearchParams` (already decoded — do not decode twice), sorted by key, joined with `\n`, key = `HMAC_SHA256("WebAppData", botToken)`, `auth_date` max age 24 h. Exclude **only** `hash` — `signature` is part of the data-check string. No Ed25519 fallback. Validate the hash is 64 lowercase hex before `timingSafeEqual`, which throws on a length mismatch.
- [ ] 1.2 **[sec]** Unit tests: valid sample; payload containing `signature`; tampered field; reordered payload; missing `hash`; wrong-length `hash`; duplicated key; non-ASCII name; a name containing a literal `%`; stale `auth_date`; **absent `user`** (Telegram sends empty initData for keyboard-button and inline launches — a refusal, never a fallback to `initDataUnsafe`, a body field or a header).
- [ ] 1.3 Nest guard resolving the user through `AccessService.resolveActiveUser`, attaching `{ access, settings, locale }` the way the bot middleware does. Unknown, disabled and deletion-pending users get one identical refusal with no enumeration.
- [ ] 1.4 **[sec]** Rate limiting in this order: IP limiter (keyed on `req.ip`, correct only with 0.5) → HMAC → `resolveActiveUser` → per-user limiter. Unsigned input must never reach PostgreSQL. In memory, resets on restart — deliberate at this size, since AI spend limits are already database-backed.
- [ ] 1.5 **[sec]** Logging: the guard throws fixed-string errors only; log context is `{ requestId, userId }` with the internal uuid, never the Telegram user object. Test by capturing stdout and stderr across a rejected and a failed authenticated request and asserting none of `hash=`, `auth_date=`, `first_name` appear. `safeError` keeps 300 characters of a message and does not know these keys, so an interpolated raw `initData` would leak in full.
- [ ] 1.6 `GET /api/v1/me`: access state, settings, locale, AI and consent state, so the client has one bootstrap call.

## 2. Tasks and goals API

- [ ] 2.1 `GET /tasks` (scope, page), `GET /tasks/today`, `GET /tasks/:id` from `TasksService.listGroupedForTelegram`, `listTodayGroupedForTelegram`, `getTask`, `getTaskCardExtras`, mapped to the contracts. Rename the shared read paths off their `ForTelegram` names and update the call sites in `src/telegram/handlers/screens.service.ts` — a rename with no behaviour change is the only edit any group but 10/11 may make under `src/telegram/`.
- [ ] 2.2 `POST /tasks/:id/state` (done, started, seen with blocker note, skipped, cancelled) through `TasksService.setOccurrenceStatus`, journaled with Undo exactly like the button.
- [ ] 2.3 `POST /tasks/:id/reschedule` including the reason requirement from `isRescheduleReasonRequired`, the presets the card exposes, and an arbitrary date/time.
- [ ] 2.4 `POST /tasks`, `PATCH /tasks/:id` and checklist writes through `ActionsService` with optimistic versions; a stale version returns a typed conflict the client can render.
- [ ] 2.5 Series: `POST /tasks/:id/series/{pause,resume}` and `GET /tasks/paused`, matching what `series:*` does today.
- [ ] 2.6 Goals: `GET /goals` (active, paused, completed), `GET /goals/:id`, link and unlink.
- [ ] 2.7 App contract tests: workspace isolation on every read, version conflict, journal row written, Undo restores.

## 3. Reminders, settings and memory API

- [ ] 3.1 `GET /reminders` (upcoming, paged), `POST /reminders/:deliveryId/{snooze,repeat}`, `DELETE /reminders/:deliveryId` (what `rem:cancel` does today).
- [ ] 3.2 `GET /settings` and `PATCH /settings` for timezone, language, digests, weekly review, quiet hours, snooze and reminder defaults, validated by the same domain rules the settings commands use, including the "apply this timezone to digests / quiet hours / both / keep" decision behind `tzapply:`.
- [ ] 3.3 `GET /memory`, `PATCH /memory/:id`, `DELETE /memory/:id` and `GET /profile` — the read side of `/memory` and `/context`. Sensitive entries keep their marking and their confirmation on write.
- [ ] 3.4 `POST /chat/history/clear` — what `/clear` and `history:clear` do today.
- [ ] 3.5 Consent: `POST /consent/{grant,revoke}`. This is a pre-check on top of the boundary check inside `ChatService` and `TranscriptionService`, which stays authoritative.
- [ ] 3.6 App contract tests: timezone validation, quiet-hours edges, consent gating, sensitive-memory confirmation.

## 4. Week plan API

- [ ] 4.1 `GET /week` — the pool and the current pick, with `targetWeekStart`, `isPickLive` and `isPickStale` from `src/core/week-plan.js` reused, not reimplemented.
- [ ] 4.2 `POST /week/pick/:taskId` and `DELETE /week/pick/:taskId` — the toggle behind `wk:t`.
- [ ] 4.3 `POST /week/take-today/:taskId` — what `wk:d` does from the morning card.
- [ ] 4.4 App contract tests: a stale pick reads as unfinished, the Monday mark is the week start in the user's timezone, workspace isolation.

## 5. Web shell, theming, i18n, data layer

- [ ] 5.1 Telegram SDK bootstrap: `ready()`, `expand()`, viewport height, theme params mapped to CSS variables (light and dark), safe-area insets.
- [ ] 5.2 Routing on the URL fragment, BackButton and MainButton wired to it, haptics on state changes.
- [ ] 5.3 A component set the screen groups agree on: list row, card, sheet, form field, date/time picker, empty state, error state, skeleton, toast, Undo snackbar.
- [ ] 5.4 `web/src/i18n/{ru,uk,en}.ts` with the resolution rule (pinned → `language_code` → English) and a test asserting the three dictionaries have identical key sets.
- [ ] 5.5 Fetch wrapper attaching `Authorization: tma <initDataRaw>`, typed errors, retry policy, and a query cache with optimistic updates for state toggles.
- [ ] 5.6 **[sec]** Treat the fragment and `tgWebAppStartParam` as navigation hints only; server scoping turns a foreign id into a not-found. Render a not-found screen rather than an error.

## 6. Web task and goal screens

- [ ] 6.1 Tasks: scope tabs with counts, an infinite list instead of eight-line pages, grouped repeats expanding to their dates, paused series in their own section.
- [ ] 6.2 Task detail: title, schedule, importance, checklist, goal, reminders, journal; inline edit with the version-conflict path.
- [ ] 6.3 Create and edit forms covering every schedule shape — exact, window, date-only, deadline, fuzzy with a review day — plus recurrence with an end date and excluded dates.
- [ ] 6.4 Reschedule sheet with the presets, an arbitrary date and the reason field when required. This is the screen the card's «Другая дата» launch button opens.
- [ ] 6.5 Occurrence actions the card no longer carries: cancel, cancel one, pause and resume series, each with its confirmation.
- [ ] 6.6 Goals list (active, paused, completed) and detail with task links.

## 7. Web today and week screens

- [ ] 7.1 Today: grouped occurrences, inline done/start/skip with an Undo snackbar. This is where the morning card's launch button lands.
- [ ] 7.2 Week plan: the pool with a checkbox per task, the current pick, and the stale-pick state.
- [ ] 7.3 Take-today from the pool, replacing the morning card's eight tap rows.

## 8. Web reminders, settings and memory screens

- [ ] 8.1 Reminders list with snooze, repeat and cancel.
- [ ] 8.2 Settings: timezone (search and detect) with the digests/quiet-hours question, language, digests, quiet hours, weekly review, reminder defaults, AI and consent.
- [ ] 8.3 **[sec]** Account deletion behind its deterministic confirmation. **Restore is not in the app**: the guard refuses deletion-pending users by design, exactly as the bot's allowlist gate does, and `/restore` stays a chat command. The deletion screen must say so.
- [ ] 8.4 Memory and profile: list, edit, delete, with sensitive entries marked and confirmed.

## 9. Infrastructure and deploy

- [ ] 9.1 **[sec]** Domain and `Caddyfile`: TLS; two `handle` blocks (`/app*`, `/api/v1/*`) proxied to `app:3000`; a final `respond 404` and **no catch-all `reverse_proxy`** — Caddy answers an unmatched path with an empty 200, and `/health` and `/ready` expose the commit SHA, database state and loop names. `admin off`. Port 80 redirects only. `request_body { max_size 64KB }` on the API.
- [ ] 9.2 **[sec]** Headers: `Content-Security-Policy: default-src 'none'; script-src 'self' https://telegram.org; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors https://web.telegram.org https://*.telegram.org; base-uri 'none'; form-action 'none'`, plus HSTS, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. **No `X-Frame-Options`** — Telegram Web opens Mini Apps in an iframe and `DENY` renders a blank page whose obvious "fix" is deleting the CSP. Keep `script-src` free of `'unsafe-inline'`: same-origin API, so an XSS here is full account control. Access logs off, or filter away `Authorization`.
- [ ] 9.3 Add Caddy to `docker-compose.yml` with a certificate volume; open 80/443 in the VPS firewall; keep 3000 and 5432 unpublished.
- [ ] 9.4 Add the web build stage to `Dockerfile` and serve `web/dist` under `/app` (hashed assets immutable, `index.html` `no-store`).
- [ ] 9.5 Update the GitHub Actions deploy for the larger build and add a post-deploy check that `/app` answers 200 over HTTPS.
- [ ] 9.6 `docs/DEPLOYMENT.md`: DNS, certificate issuance and renewal, BotFather Mini App registration, `setChatMenuButton`, rollback with `WEBAPP_ENABLED=false`, and a **revocation** paragraph — disabling a user with the admin CLI is immediate; rotating the bot token invalidates every outstanding `initData` at once and also restarts the bot.
- [ ] 9.7 `MANUAL_ACTIONS.md`: open the app from a real client on iOS, Android, desktop **and Telegram Web in a browser** (the iframe case); check theme, back button, viewport and the fragment deep link.

## 10. Launch buttons (additive, merges during rollout step 1)

Owner: the same agent as group 11. Additive only — no handler is removed here.

- [ ] 10.1 A `web_app` button on the reminder card, the escalation, the morning card and the weekly card, deep-linked with the id in the **fragment** (`${WEBAPP_URL}/#/task/<occurrenceId>`, `/#/today`, `/#/week`) so it never reaches an access log. `src/telegram/telegram.service.ts` already builds these three keyboards in one place.
- [ ] 10.2 Replace the reminder card's «⚙️ Ещё» and «📅 Другая дата» with a launch button to that occurrence's screen, once group 6.4/6.5 is live. Keep Готово, Отложить 15 м / 1 ч, +1 ч / Вечером / Завтра, Пропустить (repeats only), Замьютить (escalation only), and the reason picker after a quick reschedule.
- [ ] 10.3 Set the chat menu button to the Mini App at bootstrap when `WEBAPP_ENABLED=true`, and leave it alone when the flag is off.
- [ ] 10.4 Every screen command gains the launch button while keeping its current screen, so both surfaces work during rollout step 2.

## 11. Bot cleanup (last, alone, after production use)

The inventory below is exhaustive on purpose. A half-deleted screen tree is worse than either end
state: an orphan callback in scroll-back leaves a spinner, and an orphan copy key breaks nothing and
so is never noticed.

### 11.1 Commands removed

`/tasks`, `/task`, `/today`, `/week`, `/goals`, `/reminders`, `/settings`, `/memory`, `/context`,
`/timezone`, `/language`, `/morning`, `/weekly`, `/quiet`, `/snooze`, `/reminder_defaults`.

- [ ] Each answers, for one release, one sentence naming the app plus a launch button, then is gone.
- [ ] `setMyCommands` updated in the same change so the client menu stops advertising them.
- [ ] Settings still change by conversation: the agent's `settings` action is untouched, and `/help` says so.

### 11.2 Commands kept

`/start`, `/help`, `/status`, `/clear`, `/cancel`, `/retry_ai`, `/invite`, `/delete_account`,
`/restore`, `/ai_revoke`. `/start` onboarding is unchanged — it is the bootstrap before the app has
ever been opened.

- [ ] `/help` rewritten: what the conversation does, what the app does, what the cards do. Its
      `guide:` sub-navigation is deleted with the rest of the screens.

### 11.3 Callbacks removed

`nav:*`, `tsk:*`, `tdy:*`, `grp:*`, `view:*`, `gl:*`, `goal:<uuid>` (**keep `goal:step:<uuid>`** —
it asks the model and answers in chat), `paused:*`, `wk:t`, `wk:p`, `wk:d`, `rem:p`, `rem:cancel`,
`prefs:*`, `tzapply:*`, `profile:open`, `history:clear`, `guide:*`, `occ:more`, `occ:cancel`,
`occ:cancel_one`, `series:*`, `resched:custom`.

- [ ] Every removed pattern gets one deterministic answer for old scroll-back buttons — a sentence
      and a launch button, never silence, because an unanswered `callback_query` leaves a spinner.

### 11.4 Callbacks kept

`act:{confirm,cancel,undo}`, `occ:{done,skip,resched,back}`, `follow:snooze:{15m,1h}`,
`resched:{1h,evening,tomorrow}`, `rr:*` (the reschedule reason — four buttons, and the reason is the
point of the product), `rem:mute`, `ai:{consent,decline}`, `voice:{consent,decline}`,
`onb:*`, `account:delete_confirm`, `goal:step:*`.

### 11.5 Files

- [ ] Delete `src/telegram/handlers/screens.service.ts` and `handlers/week-callbacks.service.ts`; drop them from `telegram-handlers.module.ts` and `telegram-handlers.service.ts`.
- [ ] `handlers/system-commands.service.ts`: keep `/start`, `/help`, `/status`, `/clear`, `/cancel`, `/retry_ai`, `/invite`, `/delete_account`, `/restore`, `/ai_revoke`, `ai:*`, `account:delete_confirm`, `goal:step:*`. Remove the rest.
- [ ] `handlers/settings-commands.service.ts`: file goes away entirely once the seven commands and `prefs:*`/`tzapply:*` are gone. Anything the onboarding flow shares with it moves into `handlers/onboarding.service.ts` first.
- [ ] `handlers/task-callbacks.service.ts`: keep `occ:{done,skip,resched,back}`, `rem:mute`, `act:*`. Remove `view:*`, `occ:{more,cancel,cancel_one}`, `series:*`, `rem:cancel`.
- [ ] `handlers/reschedule-callbacks.service.ts`: keep everything except the `custom` branch.
- [ ] `telegram-keyboards.ts`: keep `taskKeyboard`, `quickRescheduleKeyboard` (minus «Другая дата»), `quickRescheduleReasonKeyboard`, `quickRescheduleReasonText`, `weeklyBriefingKeyboard` (goal steps plus a launch button), `BUTTON_LABELS` for the surviving labels. Delete `taskMoreKeyboard`, `settingsKeyboard`, `languageKeyboard`, `taskListKeyboard`, `taskScopeKeyboard`, `taskGroupKeyboard`, `taskDetailKeyboard`, `fuzzyTaskDetailKeyboard`, `weekPlanKeyboard`, `weekTakeTodayKeyboard`, `pausedSeriesKeyboard`, `remindersKeyboard`, `goalsScopeKeyboard`, `goalListKeyboard`, `goalDetailKeyboard`, `screenFooterKeyboard`, `appendFooter`, `groupCallback`, `mark`, and the `GroupSource`/`GoalScope` types.
- [ ] `telegram-screens.ts`: the file goes away. `settingsText`, `tasksOverviewText`, `todayText`, `goalsOverviewText`, `goalDetailText`, `remindersText`, `weekPlanText`, `pausedSeriesText`, `memoryText`, `taskGroupText` all have API equivalents by then.
- [ ] `telegram-format.ts` and `telegram-cards.ts`: keep only what the surviving cards and the two outside importers need — `reminderCardText` (used by `src/reminders/reminder-queue.service.ts`), `todayLine` (used by `src/briefings/briefing-content.service.ts`), `taskCardText`, `terminalTaskText`, `deployedBuildLine`, and the helpers they call. Delete list-only helpers (`groupWhenLabel`, `occurrenceWhen`, `taskWord`, `weekdayLabel` and anything else with no remaining caller).
- [ ] `telegram-ui.ts` shrinks to the surviving re-exports.
- [ ] After each deletion pass: `npx eslint src --max-warnings=0` catches unused exports and dead imports; nothing may be left exported-but-unused.

### 11.6 Copy

- [ ] Delete the removed keys from `copy/ru.ts`, `copy/uk.ts`, `copy/en.ts` **in the same commit** — a key present in one dictionary and missing in another does not compile, which is the guard that makes this safe.
- [ ] `copy/help.ts`: rewrite `helpText`, delete `guideText` and the `GuideDestination` type.
- [ ] `copy/onboarding.ts` is untouched.
- [ ] Regenerate `tests/app/__snapshots__/**`; a snapshot that still pins deleted copy is the failure mode this step exists to catch.

### 11.7 Tests

- [ ] `tests/app/telegram-callbacks.test.mjs`: remove the cases for deleted callbacks, add one asserting a deleted callback answers with a launch button instead of silence.
- [ ] `tests/app/week-callbacks.test.mjs`: delete; its coverage moves to `tests/app/webapp-week.test.mjs` (group 4).
- [ ] `tests/app/telegram-cards.test.mjs`, `telegram-copy.test.mjs`, `copy-snapshots.test.mjs`, `localization.test.mjs`: trim to the surviving surface, keep the three-dictionary parity assertion.
- [ ] `tests/app/nest-module-wiring.test.mjs`: update for the removed providers.
- [ ] Record the before/after counts of `find src/telegram -name '*.ts' | xargs wc -l` in the archive note. The target is roughly half of today's 5 032 lines.

## 12. Integrated verification

- [ ] 12.1 `npm run check` and `npm run test:e2e` on the merged branch after groups 0–9; record counts.
- [ ] 12.2 One end-to-end pass with `WEBAPP_ENABLED=false` proving production behaviour is unchanged, and one with it on.
- [ ] 12.3 Production QA on a real device before group 11 is allowed to merge: create and reschedule a task in the app, receive the reminder in chat, tap Готово there, open the same task from the reminder's launch button, plan the week in the app, and confirm a chat proposal in chat.
- [ ] 12.4 After group 11: walk the deleted commands and old scroll-back buttons and confirm each answers rather than hangs.
