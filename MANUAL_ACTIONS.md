# MANUAL_ACTIONS

Only checks/actions that cannot be completed in the current generation environment belong here. Product backlog does not.

## Before the first real run

- [ ] The incoming working archive contained a `.env` with credential-like values. If any of those values were real, rotate the PostgreSQL password, Telegram bot token and AI keys before using rc.4; the cleaned rc.4 archive contains no `.env`.
- [ ] Use Node.js 24+ with normal public npm access. Run `npm install`, commit the generated `package-lock.json`, then run `npm ci`, `npm run check` and `npm run build` from a clean checkout.
- [ ] Run `npm audit` and `npm audit --omit=dev`; review any runtime advisory before promoting the RC.
- [ ] Start a clean PostgreSQL instance and apply migrations `0001` through `0013`; restart the migration command and verify nothing is reapplied. Confirm DB CHECK/FK/unique constraints and the memory FTS GIN index exist.
- [ ] While the app is running, verify a second app instance is refused by the advisory lock and `npm run migrate` refuses to proceed. After stopping the app, verify migrations can run normally.
- [ ] Use a long random **URL-safe** `POSTGRES_PASSWORD`; never keep `.env` in source control.

## Real Telegram / AI verification

- [ ] With a real bot token, smoke-test private-chat rejection, onboarding, all task buttons, confirmation/Undo, quiet hours/snooze, digests, disable/restore and delete/restore.
- [ ] Exercise the rc.4 Telegram UX on a phone: navigate Today → Tasks → task detail → back without extra chat spam; verify Start/Done/Later/More, `••• → Проверить`, reminder cancellation, settings toggles and edit-in-place fallbacks.
- [ ] Test quick reschedule for point/window/deadline tasks, including date-only schedules, a critical/required task that requires a reason, a repeated normal reschedule, custom reason input, and Undo from the same updated task card.
- [ ] Verify all inline callback payloads remain within Telegram's 64-byte limit with real UUIDs and that stale buttons fail with a short callback toast rather than a new error message.
- [ ] With the chosen provider/model, run structured-action cases for task create/update/complete/reschedule, reminder/series changes, goals, memory, topics, clarification and an intentionally invalid structured-output/domain-action repair case. Confirm no partial action is committed.
- [ ] Verify transport failures result in at most three high-level AI attempts and do not multiply through SDK retries. Confirm retry state survives restart without duplicate durable actions.
- [ ] Revoke provider consent while a message is waiting/retrying and confirm the next provider call is blocked and the message moves to `blocked_consent`.
- [ ] Test at least one alternate provider and verify a provider switch requires fresh provider-specific consent; confirm the inactive provider receives no calls.
- [ ] Restart during pending/processing reminders, briefings, AI retry and applying/undoing actions; verify durable state is reconciled and document the expected external-send duplicate window.
- [ ] Force Telegram reply failure immediately after a successful AI action. Verify the committed action remains consistent, then decide whether the documented missing-acknowledgement risk is acceptable for `1.0.0` or warrants a durable outbound response outbox.
- [ ] Force a fatal long-polling failure and verify the process exits non-zero and the deployment supervisor restarts it.
- [ ] Test one real DST boundary in the configured IANA timezone and confirm reminder/digest delivery times.
- [ ] Smoke-test voice with valid, oversize and over-duration recordings; revoke OpenAI consent during file download and confirm transcription is blocked before provider upload.
- [ ] Run evening review through three clarification questions and answer the third; confirm the next turn concludes and the topic resolves only after that answer.
- [ ] Run weekly review with a different `digestTimezone` from the main timezone and confirm the AI advice uses the same deterministic weekly snapshot/date as the delivered briefing.
- [ ] Verify empty morning/evening/weekly briefings are persisted as suppressed with `suppressed_reason=empty` and are not sent to Telegram.

## VPS / backups / monitoring

- [ ] Deploy on the chosen EU VPS/host; verify firewall rules keep PostgreSQL and `/health` non-public and confirm the app container runs as a non-root user.
- [ ] Store Telegram/AI/S3 credentials outside source control and keep `BACKUP_KEY_FILE` separate from backup storage.
- [ ] Configure external S3-compatible backups and verify retention is 7 daily + 4 weekly encrypted dumps.
- [ ] Run `scripts/restore-compose.sh` against one encrypted backup and repeat the disposable restore drill at least monthly.
- [ ] Configure alerts for container/process health, disk, PostgreSQL, Telegram/provider errors, stuck jobs and backup freshness.

## Environment limitation recorded during rc.4 UX audit

The audit environment could not complete a public npm dependency install, so dependency-aware semantic typecheck/build and dependency vulnerability audit were not provable here. Docker/PostgreSQL and real Telegram/AI credentials were also unavailable. Deterministic core tests and dependency-independent static checks are recorded in `README.md` and `AUDIT_1.0.0-rc.4.md`.
