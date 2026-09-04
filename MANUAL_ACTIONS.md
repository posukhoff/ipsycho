# Manual release checks

This file contains only checks that cannot be proven by the local automated suite. Run `npm run check` and `npm run test:e2e` before starting this checklist.

## Credentials and access

- [ ] Rotate any PostgreSQL, Telegram or AI credential that may previously have been stored outside the current `.env.example`; never commit `.env`.
- [ ] Use a long random URL-safe `POSTGRES_PASSWORD` and keep provider, Telegram, S3 and backup-key secrets outside source control.
- [ ] Verify the Telegram allowlist, private-chat rejection and operator access on the production configuration.

## Real Telegram and provider smoke test

- [ ] With the selected real provider/model, test RU, UK and EN requests for task creation/edit/completion/reschedule, occurrence start/skip/cancel/blocker, reminders, recurring series, goals, memory and chat-accessible settings.
- [ ] Confirm explicit safe changes apply once, ambiguous changes ask one useful question, risky or inferred changes require confirmation, and Undo restores only genuinely reversible state.
- [ ] Confirm the agent does not claim success for unsupported operator/account actions and cannot access another user's data.
- [ ] On a phone, exercise Today, Tasks, task details, Reminders and Settings; verify callbacks edit the current card when possible, a stale button answers with a toast and loses its keyboard, and payloads remain within Telegram's 64-byte limit.
- [ ] As a new invited user: `/start` asks for the timezone first (buttons and a typed city such as «Берлин»), then digests, quiet hours and the weekly review, and ends on the settings card. Send a free-text message before consenting, tap «Согласен» and verify that message is processed without retyping.
- [ ] With Telegram set to English and no pinned language: Today, a task card, a reminder card, the applied report, a confirmation card and the morning digest contain no Cyrillic. Pin `/language uk` and repeat.
- [ ] From an unknown Telegram account: `/help`, a plain message and any old button all answer with the same refusal; in a group chat `/start` answers that the bot is private. Send a photo from an allowlisted account and verify the "text and voice only" reply.
- [ ] Tap Done, Skip and Cancel on task cards and verify each shows «Вернуть как было» and that Undo restores the task; press «⏰ Через 15 мин» on a reminder and verify the task's own time did not move.
- [ ] Let a critical deadline pass and verify the second escalation carries «🔴 Срок прошёл — 2-е напоминание» and the «🔕 Хватит по этой задаче» button stops further default reminders; verify a reminder that fell into quiet hours arrives with «🔕 Было в тихие часы».
- [ ] Verify a scheduled item does not print a separate reminder line when the reminder time is identical to the scheduled time.
- [ ] Test quiet hours, snooze, morning/evening digests, weekly review and notification defaults. (DST boundaries are covered by the property tests in `tests/core/time-properties.test.mjs` across nine zones.)
- [ ] Send the nine real-dialog phrasings from `docs/AGENT_FLOW.md` §2.7 (create with a reminder, "напомни через четыре часа …", two reschedules in one message, reschedule + create + goal link, every-second-Monday recurrence, weekly recurrence with a skipped first date, four tasks with a habit, "завтра после обеда" without a time). Verify each ends in one applied group, one confirmation card or one meaningful question, with exactly one provider call per message in `ai_usage`.
- [ ] Test every-second-week cadence end to end in Telegram. (Inclusive end dates, excluded dates and DST boundaries are covered by the property tests.)
- [ ] Ask for one package mixing create, reschedule and goal link. Verify exactly one card when a step needs confirmation, one applied summary, one Undo control, and that a stale target rejects the whole package with nothing applied.
- [ ] Run a weekly review where the first answer contains only the desired outcome. Verify the review continues through capacity, risks, minimum success and commitments; then accept proposed task changes explicitly and verify they use normal confirmation/Undo rules without creating memory implicitly.
- [ ] Inspect logs from applied, rejected, conflicted and undone groups. Verify they contain only ids, counts, issue codes and sanitized reason codes—not message bodies, task titles, candidate names or raw provider payloads.
- [ ] Test voice with valid, oversized and over-duration recordings; revoke OpenAI consent during download and confirm upload to the provider is blocked.
- [ ] Exercise transport errors and process restarts during AI retry, reminder processing and action acknowledgement; record whether the known external duplicate/missing-acknowledgement window is acceptable for release.
- [ ] Force a fatal Telegram polling failure and verify the process exits non-zero and the deployment supervisor restarts it.

## Production operations

- [ ] Protect `main`, require CI and deploy only the verified commit described in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- [ ] Confirm PostgreSQL and `/health` are not public and the app container runs as a non-root user.
- [ ] Configure daily encrypted S3-compatible backups with 7 daily and 4 weekly copies; keep `BACKUP_KEY_FILE` separate from the repository and bucket.
- [ ] Run `scripts/restore-compose.sh` against a selected encrypted backup before launch and at least monthly thereafter.
- [ ] Alert on process/container health, disk usage, PostgreSQL, Telegram/provider errors, stuck jobs and backup freshness.

## Contract v2 deployment

- [ ] Deploy migration `0023_message_pending_group.sql` with the application. On startup, pending confirmation cards stored under the previous action contract are expired with a `legacy_contract_expired` audit event; verify the count in the log matches the pending rows before deploy.
- [ ] Send a bare "да" to a card the bot sent last and verify it confirms; send "да" after a model question with no card and verify it goes to the model; press Reschedule on a task and type "завтра в 10" and verify the move.