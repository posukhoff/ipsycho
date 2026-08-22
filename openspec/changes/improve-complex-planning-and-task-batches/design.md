## Context

See `proposal.md` for motivation and the three delta specs for observable behavior. Today the AI returns an array of primitive actions. The action boundary permits homogeneous task creation and memory batches, rejects other multi-action arrays, then splits accepted actions into immediate and pending groups. Non-create application ultimately assumes a single action. Recurrence is represented as a restricted RRULE-like string without series bounds or exclusions, and exact task times arrive as provider-produced ISO timestamps whose textual offset is compared to the declared IANA timezone.

Weekly-review lifecycle currently infers completion from whether the AI returned a structured question. Goal advice receives goals in context but has no validated analysis subject, so a fluent reply can use the wrong conversational goal. These are cross-cutting action-contract, persistence, transaction, conversation, and prompt changes; prompt-only fixes are insufficient.

## Goals / Non-Goals

**Goals:**

- Make scheduling structure authoritative: provider output describes local intent; deterministic code derives instants and recurrence projections.
- Add a bounded task-only composite with all-or-nothing validation, persistence, confirmation, journaling, and Undo.
- Preserve existing workspace isolation, optimistic concurrency, reminder reconciliation, and truthful recovery behavior.
- Make goal selection and weekly-review completion explicit structured state rather than prose inference.
- Keep existing single-action and `create_goal_plan` behavior compatible while the new path rolls out.

**Non-Goals:**

- A general transaction language or arbitrary DAG executor for every AI action type.
- Cross-workspace or cross-user planning.
- Automatic resolution of schedule conflicts.
- Full RFC 5545 parsing, arbitrary exception expressions, or calendar-provider synchronization.
- Deterministically understanding all temporal meaning directly from raw natural-language text; provider-backed semantic tests remain necessary.

## Decisions

### 1. Add one `task_batch` composite action instead of allowing arbitrary mixed arrays

Introduce a `task_batch` action containing 1–12 ordered steps. Supported steps are `create_task`, `update_task`, `reschedule_occurrence`, and `link_task_to_goal`. Each step has a stable client-local `stepId`; references may target an owned persisted identifier/version or a preceding create step. The outer action carries source and confidence, while each inferred field that affects confirmation retains its own provenance.

The existing mixed-array rejection stays in place. The AI prompt and schema instruct the provider to emit one `task_batch` for a bounded task-only package. Existing homogeneous `create_task[]` and `create_goal_plan` inputs remain accepted during migration and may later be normalized internally to the same execution plan.

Why: removing the current batch-shape check would let downstream code process only the first unsupported primitive and would split immediate and pending effects. A composite makes package boundaries, dependencies, confirmation, and error reporting explicit.

Alternative considered: allow any primitive action array and execute sequentially. Rejected because it cannot provide atomicity, one disposition, reliable temporary references, or truthful whole-request status.

### 2. Compile the composite into a validated task execution plan before writing

Add a pure compilation phase that:

1. validates step count, unique `stepId` values, and allowed step types;
2. resolves all persisted targets under `workspaceId` and acting membership;
3. resolves temporary references only to earlier create steps;
4. checks expected versions and locks affected persisted rows in deterministic identifier order;
5. converts local scheduling and recurrence structures into domain definitions;
6. builds task, occurrence, reminder, link, and journal deltas in memory;
7. calculates a single batch disposition and a per-step user-facing summary.

No repository write or queue call occurs during compilation. Errors carry a safe step index, step label, field, and domain reason; raw provider payloads and message bodies are not logged.

Why: validation-before-write prevents compensating logic from becoming the normal atomicity mechanism and produces precise feedback for structured repair and the user.

### 3. Persist the entire task plan and action journal in one PostgreSQL transaction

Add repository methods that accept a transaction-scoped database client and apply the compiled plan under one action group. The transaction writes task/occurrence/reminder/link changes, primitive action events, and the final action-group state together. Primitive event types remain `create_task`, `update_task`, `reschedule_occurrence`, and `link_task_to_goal`; the group records that it originated from `task_batch` without replacing the primitive undo evidence.

Reminder queue enqueue/rebuild calls happen only after commit. Failures are sanitized and left for existing reconciliation to retry. Telegram delivery remains outside the transaction.

Why: one database transaction is the only reliable all-or-nothing boundary. Keeping primitive journal events preserves audit readability and makes rollback logic reason about real mutations rather than an opaque batch blob.

Alternative considered: apply each existing service method and compensate on failure. Rejected because queue effects, optimistic versions, and partial compensation would make “nothing changed” and Undo claims unreliable.

### 4. Derive one confirmation disposition from all steps

Run current per-action disposition rules over every compiled step. The batch disposition is `confirm` if any step requires confirmation; otherwise it is `apply`. A pending batch is stored as one payload and one action group, and its confirmation summary enumerates every step and inferred/high-risk field. Confirmation re-runs ownership, version, time, and domain validation before applying.

Memory, settings, consent, account, quiet-hours bypass, and other action domains are schema-invalid inside `task_batch`. If a message requests both task and non-task changes, the AI must propose a clear sequence and the application must not imply that the whole request executed.

Why: splitting a user-perceived package between immediate and pending states creates ambiguous partial success.

### 5. Use structured local scheduling and structured recurrence

Extend task action input with a local schedule structure rather than treating provider ISO timestamps as authoritative:

- exact/window schedule: local date, local start time, optional local end time or duration, and IANA timezone;
- date-only/deadline/fuzzy modes: only fields valid for that mode;
- recurrence: frequency, interval, weekdays or month days, optional local times, `startsOn`, optional `endsOn`, and up to 32 explicit excluded local dates.

Deterministic conversion derives persisted UTC instants from local fields and timezone using existing DST-safe helpers. Legacy ISO action fields remain accepted during a compatibility window; equivalent `Z` or explicit-offset instants are canonicalized to the declared timezone. When both local and legacy instant fields are present, local fields are authoritative and a mismatch is rejected.

Persist `recurrence_end_local_date` as a nullable task column and persist exclusions in a workspace-scoped `task_recurrence_exclusions` table with a unique `(workspace_id, task_id, local_date)` key and composite task foreign key. Recurrence generation filters after the end date and excluded dates before creating occurrences or reminders. Existing RRULE strings remain readable; new provider output is compiled into the supported internal rule.

Why: structured recurrence prevents unsupported fields such as `BYSETPOS`, makes interval and bounds first-class, and avoids silently storing behavior only in task context.

Alternative considered: add `UNTIL` and exception syntax to the existing free-form rule. Rejected because it leaves provider string generation as the primary validator and expands parsing ambiguity.

### 6. Validate a structured goal-analysis subject

Extend the AI response contract with an optional analysis focus containing `goalId` and `expectedGoalVersion` whenever the reply claims to analyze a persisted goal. Before the provider call, build goal-selection metadata:

- exact owned title mention selects one candidate;
- one active candidate may be selected for a generic reference;
- multiple plausible persisted or conversational goals mark selection as ambiguous.

If selection is ambiguous, the system prompt requires one focused clarification and no mutations. If the reply nevertheless analyzes a goal without a valid focus, structured repair is attempted; failure returns a safe clarification. A validated focus causes the response context to include the goal title and linked-task evidence used for advice.

Why: advice itself is not a mutation, but workspace ownership and factual grounding still require a deterministic subject boundary.

Alternative considered: rely on prompt emphasis around `CURRENT_CONTEXT.goals`. Rejected because production QA already showed fluent selection of the wrong goal.

### 7. Track weekly planning dimensions explicitly

Add nullable `review_state` JSONB to `conversation_topics`, validated by a versioned Zod schema at every read/write. For weekly reviews it stores coverage and concise summaries for outcome, capacity/energy, risks/blockers, minimum success, and considered commitments, plus `conclusionRequested` and schema version. It does not duplicate raw messages.

Extend the structured AI turn with `reviewProgress` evidence for dimensions learned in that turn. Deterministic lifecycle code merges validated progress, considers the configured clarification ceiling, and resolves only when all required dimensions are covered, the user explicitly requests conclusion, or the ceiling forces a labeled best-effort conclusion. Whether reply prose happens to contain a question no longer determines completion.

If the reply asks a continuation question but omits the structured question, one structured repair is required. If repair fails, the application returns a deterministic focused question for the next missing dimension. Final responses are normalized to remove dangling optional-follow-up questions.

Why: lifecycle state must represent planning completeness, not model formatting behavior.

### 8. Make weekly memory and mutations deterministic

During a weekly review, memory actions are rejected unless the latest user message contains an explicit memory-specific request and normal memory sensitivity/disposition checks pass. Generic statements of outcomes, risks, capacity, and preferences for the coming week remain review context.

Task actions during an active review are advisory unless the latest message explicitly accepts named changes. Accepted changes flow through `task_batch`; review code does not bypass batch validation or confirmation.

Why: review conversation is transient planning input and must not pollute durable profile context or mutate the schedule implicitly.

### 9. Test in deterministic layers and provider-backed gates

Add pure tests for structured recurrence compilation, end/exclusion projection, local-time canonicalization, batch shape/disposition, goal selection, and weekly state transitions. Add application contract tests for structured repair, precise user errors, and review memory suppression. Add PostgreSQL e2e tests for atomic commit/failure, row locking/version conflicts, composite workspace constraints, one-group journaling, full Undo, and reminder reconciliation.

Provider-backed scenarios use isolated synthetic users and assert both response quality and database effects for the exact QA prompts that exposed the defects. They remain an explicit release gate rather than a deterministic unit-test dependency.

## Risks / Trade-offs

- **[Risk] Task batches hold more rows and can increase transaction contention** → Limit batches to 12 steps, lock rows in deterministic order, validate outside the transaction where safe, and keep network/queue work after commit.
- **[Risk] JSON review state drifts across releases** → Version and schema-validate it, treat invalid state as recoverable missing coverage, and never trust it for authorization or mutation.
- **[Risk] New recurrence bounds change future occurrence materialization** → Apply only to new/edited bounded series; existing rows remain unbounded unless explicitly updated.
- **[Risk] Finite exclusions grow payload and query cost** → Cap at 32 dates per action, store them in an indexed table, and load only for the projected series horizon.
- **[Risk] Local fields can still semantically misrepresent natural language** → Keep structured repair and provider-backed semantic scenarios; deterministic code guarantees internal time consistency, not universal language understanding.
- **[Risk] A whole batch may require confirmation because of one inferred step** → Prefer safety and explain which step triggered confirmation; users can remove that step and resubmit the safe subset.
- **[Risk] Old application code cannot safely Undo new mixed groups** → Ship schema support first, keep task batches feature-gated off until the new apply/Undo path is deployed and verified, and disable new batches for at least the Undo TTL before any code rollback.
- **[Risk] More focused clarifications can feel slower** → Ask at most one question per turn and skip questions for already supplied dimensions.

## Migration Plan

1. Add an append-only migration with nullable `tasks.recurrence_end_local_date`, workspace-scoped recurrence exclusions, and nullable `conversation_topics.review_state`; existing behavior remains unchanged.
2. Deploy read compatibility and deterministic recurrence/review-state code while task-batch generation remains disabled.
3. Deploy task-batch contracts, compiler, transactional repository path, confirmation, Undo, and Telegram presentation behind a default-off feature switch.
4. Run deterministic checks, PostgreSQL e2e, migration rehearsal, and isolated provider/Telegram scenarios.
5. Enable structured recurrence output, then weekly lifecycle changes, then task batches in that order so failures are attributable and reversible.
6. Monitor sanitized validation reason codes, structured-repair rate, batch conflict rate, Undo failures, review completion depth, and reminder reconciliation failures.

Rollback:

- Disable task-batch generation first. Existing nullable columns and tables are backward-compatible and are not dropped.
- Wait at least the configured Undo TTL or retain the new Undo handler while rolling back other behavior, so applied mixed groups remain truthfully reversible.
- Cancel unsupported pending task-batch groups with an audited operator action before deploying code that cannot confirm them.
- Existing tasks created under the new path remain ordinary workspace-scoped tasks and continue to run; bounded recurrence data must continue to be honored by the compatibility reader.
