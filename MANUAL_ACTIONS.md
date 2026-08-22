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
- [ ] On a phone, exercise Today, Tasks, task details, Reminders and Settings; verify callbacks edit the current card when possible, stale buttons fail briefly, and payloads remain within Telegram's 64-byte limit.
- [ ] Verify a scheduled item does not print a separate reminder line when the reminder time is identical to the scheduled time.
- [ ] Test quiet hours, snooze, morning/evening digests, weekly review, notification defaults and one real IANA timezone DST boundary.
- [ ] Test voice with valid, oversized and over-duration recordings; revoke OpenAI consent during download and confirm upload to the provider is blocked.
- [ ] Exercise transport errors and process restarts during AI retry, reminder processing and action acknowledgement; record whether the known external duplicate/missing-acknowledgement window is acceptable for release.
- [ ] Force a fatal Telegram polling failure and verify the process exits non-zero and the deployment supervisor restarts it.

## Production operations

- [ ] Protect `main`, require CI and deploy only the verified commit described in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- [ ] Confirm PostgreSQL and `/health` are not public and the app container runs as a non-root user.
- [ ] Configure daily encrypted S3-compatible backups with 7 daily and 4 weekly copies; keep `BACKUP_KEY_FILE` separate from the repository and bucket.
- [ ] Run `scripts/restore-compose.sh` against a selected encrypted backup before launch and at least monthly thereafter.
- [ ] Alert on process/container health, disk usage, PostgreSQL, Telegram/provider errors, stuck jobs and backup freshness.
