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
- [ ] Tap Done, Skip and Cancel on task cards and verify each shows «Вернуть как было» and that Undo restores the task; press «⏰ Через 15 мин» on a reminder and verify the task's own time did not move. Verify no card offers «Начал» and that «Поставить серию на паузу» appears only for a repeat without an end date.
- [ ] Let a critical deadline pass and verify the second escalation carries «🔴 Срок прошёл — 2-е напоминание» and the «🔕 Хватит по этой задаче» button stops further default reminders; verify a reminder that fell into quiet hours arrives with «🔕 Было в тихие часы».
- [ ] Verify a scheduled item does not print a separate reminder line when the reminder time is identical to the scheduled time.
- [ ] Create an all-day event («весь день в субботу конференция») and verify it is saved and reminded on the morning of that day, not refused.
- [ ] Pause a recurring series, open `/tasks` and verify the «⏸ На паузе» button lists it; resume it and verify the future dates come back, the row disappears and no Undo is offered for the resume (pausing again is the way back).
- [ ] With the provider unreachable, send a message and verify the bot answers that it will try again, retries twice, and then writes once more with a quote of the message and `/retry_ai`.
- [ ] Ask for a reminder on a task with no date («к осени разберусь с гаражом, напомни») and verify one contact on its review day, not two.
- [ ] Describe a task as an outcome («надо бы разобраться с налогами до конца сентября») and verify one task with a first concrete step and three to five steps, the report showing them, and Undo taking the whole thing back. Then say «не дроби» and verify the step and the list are emptied. Repeat with «завтра в 10:30 позвонить в клинику» and verify no steps are invented.
- [ ] Tick one checklist item, then have the model restate the steps (ask it to add one) and verify the tick survived.
- [ ] Open `/week`: verify the past week's line, the pool ordered with last week's untaken pick first, that a tap takes a task for the week and the same tap releases it, and that the eighth pick is refused with a toast.
- [ ] On the morning card, verify the day's plan, the «взято на неделю» block, and that one tap sets a task for today, removes its row and leaves the others.
- [ ] Verify the weekly card arrives on its configured day with the pool count and a button to `/week`, and that no review conversation starts anywhere.
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
- [ ] Type «да» instead of tapping at each onboarding step after the timezone and verify the answer lands and the flow moves on; type something else and verify it re-asks rather than reaching the model.
- [ ] Let a dated task go overdue, then open `/week` and verify it is in the pool with «просрочено», leads the list, and that one tap takes it for the week and another gives it today.
- [ ] On a task with no day, ask for a reminder at an exact date and time and verify it arrives; ask for «за 15 минут до начала» and verify the refusal explains what to give instead.
- [ ] Open a task from the «⚠️ Просрочено» filter, press Back, and verify the same filter is still selected. Complete a task from a list and verify the card that replaces it still has the footer.
- [ ] Send `/memory` and verify a sensitive fact is listed with 🔒; verify `/context` speaks the interface language.
- [ ] Leave a goal untouched for three weeks (or backdate `goals.updated_at`) and verify the weekly card names it with the days of silence and offers a step; tap it and verify one task linked to the goal comes back with Undo.
- [ ] Deploy migration `0029_telegram_language.sql` with the application, then send any message and verify `user_settings.telegram_language` is filled. With no pinned language, verify the morning card, a reminder and the spend warning arrive in the Telegram language rather than in English.
- [ ] Deploy migration `0028_week_pool.sql` with the application. Existing tasks have no week mark, so the pool starts empty of picks; verify `/week` lists the undated tasks and that picking one writes this week's Monday.