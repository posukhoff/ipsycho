# IPsycho product and technical production QA — 2026-08-23

> **Stale (2026-09-04).** The code paths this audit names (`goal-focus`, task batches, the three-layer action contract) were removed in the September rework. Only the dialogue scores below remain useful, as the baseline the eval loop compares against.

> Remediation status: QA-PT-001 through QA-PT-004 have been addressed locally after this audit with deterministic guards, prompt changes and regression tests. The fixes are not yet deployed to production; see the post-QA verification notes in the active OpenSpec change.

## Executive summary

Production is healthy and its deployed commit matches the local verified commit: `ddaba510e6feb22f67f3130d16501a039284a73d` (`docs: record complex planning production QA`). Migrations `0001`–`0022` are applied. The app and PostgreSQL containers are healthy; `/health` returned `200 {"status":"ok"}` before and after the test. The app container runs as user `node`. `NODE_ENV=production`, provider is OpenAI, model used by the production runners is `gpt-5.4-mini`, and `TASK_BATCH_ENABLED` is unset/disabled. The flag and production configuration were not changed.

The agent is already useful for grounded planning, goal advice and weekly reviews. Its strongest behavior is the weekly-review lifecycle: it continues after an outcome-only answer, respects low capacity, finishes on request with explicit assumptions, and does not create work from an advisory plan. The principal release concern is consent precision: an ordinary explanatory reply created a three-action pending confirmation before the user accepted the assistant's offer to turn the advice into tasks. A second concern is disabled-mode handling of a clear mixed request: it asks for redundant confirmation instead of clearly explaining that atomic mixed actions are unavailable.

Real Telegram receipt and button interaction were not tested because Telegram Web had no authorized session and showed the QR login screen. No token or `.env` content was accessed. All feasible tests were performed via isolated production runners, database state checks, sanitized output and local automated suites.

## Environment and evidence

- Production host: remote Docker Compose deployment at `/opt/ipsycho`.
- Commit: `ddaba510e6feb22f67f3130d16501a039284a73d`.
- Package: `1.0.0-rc.4`.
- Health: app and PostgreSQL healthy; application `/health` 200 before and after QA.
- Migrations: all files through `0022_complex_planning_foundations.sql` applied.
- Rollout: `TASK_BATCH_ENABLED=<unset>`; disabled throughout QA.
- Verification: `npm run check` passed 181 core + 52 app tests (233 total); `npm run test:e2e` passed 17/17 PostgreSQL tests and removed its disposable Docker environment.
- Production runners: two isolated synthetic workspaces, with AI consent granted only to the synthetic users. Both cleanup checks returned zero workspace residue. The expanded run also returned zero action groups, briefing deliveries and reminder deliveries after deletion.
- Production aggregate queue observation after QA (not synthetic-user evidence): briefing deliveries 4 pending, 1 sent, 2 suppressed; reminder deliveries 5 pending, 2 sent.
- Log privacy: the rejected-action diagnostic contained role, length, SHA-256, context key names, time context, error codes and action types; it did not contain message text, task titles, raw provider payloads or secrets.
- Codebase evidence tier: Verify. Codebase Memory generation `2026-08-22T22:01:18Z`, full mode, matched commit. `src/chat/chat.service.ts` has one reported parser gap at line 693; that exact source range was read directly. Other cited paths have no recorded coverage gap. This is best-effort coverage, not proof of completeness.

## Scenario results

| Scenario | Input messages | Expected | Actual | Result | Severity | Evidence |
|---|---|---|---|---|---|---|
| P0: unclear goal, first turn | Exact requested opening about launching a pilot and not wanting 20 tasks | Ask about current state/constraints; separate goal from actions; 1–3 steps; no mutation | Used existing task history and proposed three compact pillars. It did not ask a clarifying question or label assumptions. No action was created | FAIL | P1 | `P0_DISCOVERY_1`, `applied=0`, `pending=0` |
| P0: low energy and four hours | “Продукт вроде почти готов… Есть только четыре часа… энергии мало” | Adapt plan; offer next steps without creating tasks until explicit acceptance | Gave three sensible small steps, but simultaneously created a pending group with three actions while saying “Если хочешь, я могу…” | FAIL | P1 | `P0_DISCOVERY_2`, `pendingCount=3`, `hasPendingGroup=true` |
| P0: priority change | Sleep becomes more important than the pilot | Retain context and revise priority without overload | Correctly put the pilot in the background, retained existing steps, added nothing | PASS | — | `P0_DISCOVERY_3`, `applied=0`, `pending=0` |
| P0: mixed request, disabled mode | Exact multi-operation pilot/offer/outreach/Anton/training exception/gift request | With flag disabled: no batch or partial mutation; clear safe explanation | No task, goal or delivery state changed. It asked whether the explicitly supplied Thursday 16:00 Kyiv time really meant 16:00 Kyiv and claimed it would then enter everything. It did not explain disabled mode | FAIL | P1 | Counts stayed 4 tasks/2 goals/6 deliveries; `P0_MIXED_DISABLED` |
| P0: atomicity under disabled mode | Same mixed request | Zero partial state | Tasks, goals and deliveries remained identical. One action group existed, attributable to the earlier premature proposal, not the mixed request | PASS | — | Baseline vs after-mixed counters; local PostgreSQL atomic-batch E2E passed |
| P0: ambiguous goal advice | “Скажи честно, что сейчас слабее всего в моей цели…” with two goals | One concrete question; no mutation | Named both goals and asked which one to analyze; no mutation | PASS | — | First production runner, ambiguous-goal turn |
| P0: ambiguous meeting | “Перенеси встречу с клиентом на пятницу” with Anton and Andrey meetings | One concrete question, understandable options, no mutation | Asked “с Антоном или с Андреем?”; no mutation | PASS | — | `AMBIG_MEETING` |
| P0: ambiguous goal link | “Привяжи подготовку оффера к цели” with two similar goals | One concrete question, understandable options, no mutation | Named both goals and asked which one; no mutation | PASS | — | `AMBIG_OFFER` |
| P0: weekly review, sequential | Outcome, capacity/energy, risks, minimum success and commitments in separate turns | Do not finish after first substantive answer; collect five dimensions; grounded final plan; no mutation | Continued through all five dimensions, produced a capacity-aware prioritized plan and created no actions | PASS | — | First runner: progress 1→3→4→5; final `review.completed=true`, `applied=0`, `pending=0` |
| P0: weekly review, all dimensions at once | One long message with all five dimensions and “ничего пока не создавай” | Do not repeat answered questions; retain all five fields; finish | Finished immediately and did not ask repeats or mutate. Internal progress log recorded only 4 provided dimensions and the response added an assumptions disclaimer despite all five being present | FAIL | P2 | `WEEKLY_ALL`; log `providedCount: 4`, response `review.completed=true` |
| P0: weekly review, stop questions | Outcome + low capacity, then “Хватит вопросов…” | Finish with explicit assumptions and no mutation | Produced a one-focus minimum plan, clearly deferred outreach, explicitly labeled assumptions, no actions | PASS | — | `WEEKLY_STOP_1/2`, final `review.completed=true` |
| P0: accept only selected plan items | “Прими только первые два пункта…” | Create only selected items | Not executed because production batch rollout is disabled and there was no Telegram confirmation surface. The disabled-mode and atomicity layers were tested separately | NOT TESTED | — | Rollout constraint |
| P0: advice—focus | “На чём… и почему?” for exact pilot goal | Use real facts; prioritize; next step and trade-off | Grounded in the two linked active tasks and chose offer → outreach. Minor unsupported assertion that messages would be weaker without the offer | PASS with note | P2 | `ADVICE_FOCUS` |
| P0: advice—why deferring | “Почему… Не выдумывай причин” | Separate facts from hypotheses | Explicitly said the reason is unknown and offered hypotheses as alternatives, not facts | PASS | — | `ADVICE_DEFERRAL` |
| P0: advice—continue or stop | Exact pilot goal | Grounded recommendation and trade-offs | Recommended continue/pause based on two active linked steps and resource availability; no invented progress metric | PASS | — | `ADVICE_STOP` |
| P0: advice—smallest experiment | Exact pilot goal | Small executable learning step | Proposed 1–2 customer conversations, one question, and four compact execution bullets | PASS | — | `ADVICE_EXPERIMENT` |
| P0: advice—half energy | Low-energy counterfactual | Remove secondary work and preserve minimum | Removed presentation/polish, kept 1–2 conversations or just a short message, protected sleep | PASS | — | `ADVICE_LOW_ENERGY` |
| P1: “Не сохраняй это” | Sensitive fear statement plus explicit no-save | Conversational reply allowed; no action or memory mutation | Explicitly confirmed no save/change; no pending or applied action; final action-group count unchanged | PASS | — | `NO_SAVE`, `applied=0`, `pending=0` |
| P0/P1: recurrence, DST, quiet hours, snooze, stale suppression | Automated controlled-time cases | Correct local-time recurrence and delivery policy | Core tests passed Kyiv DST, nonexistent wall time, bounded recurrence/exclusions, quiet-hours deferral, snooze and stale suppression | PASS (logic only) | — | 233-test `npm run check` output |
| P0: delivery exactly once and retry safety | Materialization → queue → Telegram receipt | One receipt; retry without duplicate; buttons work | Database constraints and message/action idempotency passed automated tests. End-to-end Telegram receipt and retry were unavailable | PARTIAL | — | E2E “one Telegram message… one active action group”; Telegram UI unavailable |
| P0: Telegram cards/buttons | Confirm/cancel/Undo/start/done/skip/reschedule/seen/blocker/series scope; repeated clicks | Correct cards, idempotent callbacks, no false success | Not testable: Telegram Web session was not authenticated | NOT TESTED | — | QR login screen |
| P1: voice and consent during retry | Normal/long/large audio and revoke consent at provider boundary | Limits enforced; revoked consent blocks provider | Size/duration validation and provider-boundary consent are covered by automated tests/code inspection; real voice upload/retry not run | PARTIAL | — | Core voice-limit tests; `processPersistedMessage` rechecks gate before provider/repair |
| P1: provider/Telegram timeout | Failures and reprocessing | No duplicate state; ambiguous external delivery handled honestly | State idempotency is tested; real Telegram timeout was not injected on production | PARTIAL | — | E2E idempotency; documented external delivery ambiguity remains |

## Dialogue scores (0–5)

| Dialogue | Intent | Clarifications | Realism | Facts | Priority | Safety | Time/recurrence | Advice | Language | Context |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Unclear pilot + contradiction + priority change | 4 | 2 | 4 | 4 | 5 | 2 | 3 | 4 | 5 | 5 |
| Mixed operation request, disabled mode | 4 | 1 | 2 | 4 | 3 | 5 | 2 | 2 | 4 | 4 |
| Ambiguous goal/meeting/link | 5 | 5 | 4 | 5 | 4 | 5 | 4 | 4 | 5 | 4 |
| Weekly review, sequential | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 5 |
| Weekly review, all-in-one | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 | 5 | 4 |
| Weekly review, forced conclusion | 5 | 5 | 5 | 4 | 5 | 5 | 4 | 5 | 5 | 5 |
| Five goal-advice questions | 5 | 4 | 5 | 4 | 5 | 5 | 3 | 5 | 5 | 5 |

Agent-quality average across the scored dialogues: **4.4/5**. Weekly planner: **4.7/5**. Product readiness for the requested full contract: **3.6/5**, reduced mainly by unverified Telegram delivery/UI, disabled batch rollout, and the pending-action consent defect.

## Defects

### QA-PT-001 — pending actions are created before the user accepts the assistant's offer

- Priority/severity: **P1 / high**.
- Production commit: `ddaba510e6feb22f67f3130d16501a039284a73d`.
- Reproduction:
  1. Have a pilot goal and a few related active tasks in the synthetic workspace.
  2. Send the requested unclear-goal opening.
  3. Reply: “Не знаю точно. Продукт вроде почти готов, но показать стыдно. Есть только четыре часа на неделе и энергии мало”.
  4. Observe reply ending with “Если хочешь, я могу сейчас превратить это в 2–3 очень маленькие задачи…”.
  5. Observe `pendingCount=3`, `pendingGroupId` present and one persisted action group.
- Expected: advice only; `actions=[]`, `pendingCount=0` until the user says yes or explicitly asks to create/schedule tasks.
- Actual: three AI-inferred actions were stored for confirmation before acceptance.
- User impact: an unsolicited confirmation card can appear while the assistant is still merely offering to create tasks. This weakens autonomy and makes the system feel overeager, even though task state is not yet applied.
- Safe log/evidence: synthetic runner result only; no real-user content. Counts moved from `groups=0` to `groups=1`; tasks remained 4.
- Probable code area:
  - `src/chat/chat.service.ts` calls `actions.handleProposed()` after schema/domain validation.
  - `src/core/ai-actions.ts::validateMutationIntent()` only rejects a `user_explicit` mutation when the latest user text looks like a question/tentative suggestion. It does not gate AI-inferred actions against explicit acceptance or reply semantics.
  - `src/actions/actions.service.ts::storePending()` persists every confirmation-required proposal once it reaches the action layer.
  - The system prompt tells the model to mark proposed actions as `ai_inferred`, but does not prohibit emitting them when the assistant text says it will create them only if the user wants.
- Recommendation: add a deterministic “proposal offered but not accepted” guard before `handleProposed`. At minimum, reject actions when the assistant reply conditions creation on future consent (“если хочешь…”) and the latest user message contains no mutation request. Prefer a positive mutation-intent classifier over expanding negative regexes. Add an app contract test with this exact dialogue and assert `pendingCount=0` and no action group.

### QA-PT-002 — clear mixed request in disabled mode receives a redundant time confirmation

- Priority/severity: **P1 / high product blockage**.
- Production commit: `ddaba510e6feb22f67f3130d16501a039284a73d`.
- Reproduction: send the exact mixed request from the test specification while the user's timezone is `Europe/Kyiv` and the Anton meeting is uniquely present.
- Expected: no partial mutation; concise explanation that an atomic mixed package is unavailable while rollout is disabled, with a safe next option. It must not ask for information already supplied.
- Actual: “на какое именно время в четверг в 16:00… это начало в 16:00 по Киеву, верно?” followed by “После этого сразу внесу всё остальное.” No action was applied.
- User impact: blocks a fully specified request, repeats the time, and promises behavior unavailable under the current rollout.
- Safe log/evidence: task/goal/delivery counts unchanged; no raw production log content.
- Probable code area:
  - `src/ai/ai.service.ts::buildSystemPrompt()` disabled branch allows only homogeneous `create_task[]` or one ordinary mutation, so the requested mixed operation has no representable safe action.
  - `src/chat/chat.service.ts::shouldRetryActionlessTaskBatch()` explicitly returns false when the rollout is disabled, so actionless or misleading model replies do not receive a deterministic correction.
- Recommendation: add a deterministic disabled-mode response for explicit mixed task-operation intent. It should say that the package cannot be applied atomically right now, preserve the parsed operation summary, and ask whether to proceed one operation at a time only if that is a truthful supported flow. Never ask to reconfirm a supplied timezone/time.

### QA-PT-003 — all five weekly dimensions are not fully captured from one long message

- Priority/severity: **P2 / medium**.
- Production commit: `ddaba510e6feb22f67f3130d16501a039284a73d`.
- Reproduction: start weekly review and provide outcome, energy/capacity, risks, minimum success and commitments in the same message, ending with a request for a final plan and no mutations.
- Expected: five provided dimensions, immediate conclusion, no repeated question, no assumptions label for already supplied fields.
- Actual: review concluded correctly and did not repeat questions, but the safe progress log reported `providedCount=4`; final text added “недостающие ограничения… требуют проверки”.
- User impact: the plan remains useful, but the review state loses one piece of supplied evidence and can present unnecessary uncertainty.
- Safe log/evidence: `weekly review progress { providedCount: 4, clarificationCount: 1 }`; synthetic message only.
- Probable code area: `src/chat/chat.service.ts` applies `groundWeeklyReviewProgress()` and merges state; `src/core/weekly-review-state.ts` controls completion/assumptions.
- Recommendation: add the exact all-in-one Russian message to weekly lifecycle tests, assert all five persisted dimensions, `completed=true`, no question, and no assumptions label. Improve deterministic grounding patterns for commitments/minimum-success wording before relying on provider-authored progress.

### QA-PT-004 — initial discovery does not explicitly elicit current state/constraints

- Priority/severity: **P2 / medium coaching quality**.
- Production commit: `ddaba510e6feb22f67f3130d16501a039284a73d`.
- Reproduction: exact requested unclear-goal opening with related tasks already present.
- Expected: briefly reflect known facts and ask one question about current state or available time/energy while limiting next steps.
- Actual: proposed three sensible pillars and offered to create tasks, but asked no discovery question and did not distinguish assumptions from facts.
- User impact: the plan is compact but may prematurely lock onto the existing task framing instead of discovering the actual bottleneck.
- Probable code area: AI system prompt/product prompting rather than deterministic mutation layer.
- Recommendation: for “I don't know where to start” intent, require one compact response containing known facts, at most two explicitly labeled assumptions, 1–3 provisional next steps, and one high-value constraint question. Keep the no-question rule for clear operational commands.

## Issue priority list

- **P0:** none observed in the exercised paths. No cross-workspace access, partial batch commit, duplicate confirmation claim, or cleanup failure was found.
- **P1:** QA-PT-001 premature pending actions; QA-PT-002 misleading/redundant disabled-mode handling.
- **P2:** QA-PT-003 incomplete all-in-one weekly grounding; QA-PT-004 weak first-turn discovery; minor unsupported causal phrasing in one advice answer.

## What could not be verified

- Real Telegram delivery, visual card layout and all requested buttons because Telegram Web was unauthenticated.
- Repeated real button presses and Telegram callback idempotency at the UI boundary.
- Exactly-once receipt, Telegram timeout behavior, stale acknowledgement behavior and actual snooze delivery for the synthetic user.
- Real voice upload, oversized Telegram media, provider upload cancellation during a race and voice retry.
- Production batch confirmation, full atomic apply, one Undo and selective acceptance of two plan items because `TASK_BATCH_ENABLED` is disabled and was intentionally not changed. Atomic batch and Undo behavior were verified in local PostgreSQL E2E/unit layers.
- A live DST delivery transition in Telegram; DST and nonexistent local-time behavior were verified under controlled test time without changing production system time.
- Provider failure injection on the production app. The real provider did exercise structured repair, including a rejected turn whose logs remained sanitized.

## Highest-impact improvements

1. Fix the deterministic consent boundary for AI-inferred pending actions. This directly protects trust and autonomy.
2. Add an explicit, truthful disabled-mode response for mixed task operations so the agent neither stalls nor promises unsupported atomic behavior.
3. Strengthen deterministic weekly-dimension grounding for all-in-one messages and test exact Russian phrasing.
4. Run the remaining Telegram matrix with an authorized dedicated QA account before expanding rollout: receipt, buttons, duplicate callbacks, quiet hours, snooze, stale reports and timeout ambiguity.
5. After Telegram QA, enable batch only for the synthetic allowlisted user in a separately authorized maintenance window, run one full package/confirmation/Undo/selective-acceptance scenario, then disable it and recheck cleanup before any wider rollout.

## Cleanup

- Production runner 1: `workspace_residue=0`.
- Production runner 2: `workspace=0`, `groups=0`, `briefingDeliveries=0`, `reminderDeliveries=0` after deleting the synthetic user.
- Synthetic tasks, goals, task-goal links, topics, messages, action groups and deliveries were removed by user/workspace cascade.
- A post-cleanup orphan scan returned zero rows without a workspace across `messages`, `tasks`, `goals`, `conversation_topics`, `action_groups`, `briefing_deliveries` and `reminder_deliveries`.
- The local E2E Docker container and network were stopped and removed by the test script.
- The temporary local runner file and unauthenticated Telegram browser tab were removed/closed.
- No production configuration, rollout flag, repository source file, migration, secret or real-user record was changed.
