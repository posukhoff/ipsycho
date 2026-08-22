## Purpose

Defines how IPsycho converts natural-language task requests into faithful schedules and applies bounded multi-task changes atomically and recoverably.

## ADDED Requirements

### Requirement: Preserve user scheduling semantics
The system SHALL preserve every material scheduling constraint explicitly supplied by the user, including local date, local time or window, duration, deadline, recurrence cadence, interval, timezone, series start, series end, and supported excluded dates. It MUST NOT retain a constraint only as descriptive text when that constraint affects scheduling behavior.

#### Scenario: Bounded recurring series
- **WHEN** a user creates a task every Tuesday and Thursday at 18:30 through September 24 in their timezone
- **THEN** the persisted series produces occurrences only on the requested weekdays and does not produce an occurrence after September 24

#### Scenario: Every second weekday
- **WHEN** a user requests a task every second Monday at 09:15 from September through November
- **THEN** the system persists a two-week interval, the requested local time, and the requested series bounds without converting the request to a different recurrence form

#### Scenario: Supported finite exclusion
- **WHEN** a user creates a weekly series and explicitly excludes the first otherwise-matching local date
- **THEN** the system persists that exclusion and does not create or deliver reminders for the excluded occurrence

#### Scenario: Unsupported recurrence form
- **WHEN** a recurrence cannot be represented by the supported domain model without changing its meaning
- **THEN** the system asks a focused clarification or explains the unsupported constraint before creating any task

### Requirement: Preserve uncertainty instead of inventing precision
The system SHALL represent an imprecise date or time with the corresponding fuzzy or date-only domain value. It MUST NOT invent a precise execution time merely to satisfy a structured action contract.

#### Scenario: Fuzzy afternoon request
- **WHEN** a user says a task is for tomorrow afternoon and explicitly says not to invent an exact hour
- **THEN** the task remains date- or horizon-based without a fabricated execution time, and any optional review checkpoint is identified separately before mutation

#### Scenario: Deadline without start time
- **WHEN** a user provides only a deadline and asks not to schedule the work itself
- **THEN** the system stores the deadline without adding a planned start time

### Requirement: Normalize timestamp representation deterministically
The system SHALL accept an AI-produced instant that represents the correct user-local date and time even when it is serialized with a different valid UTC offset representation, and SHALL canonicalize it to the declared IANA timezone before persistence. It MUST reject a value whose instant resolves to a different user-local meaning.

#### Scenario: Equivalent UTC instant
- **WHEN** an action for 14:00 Europe/Kyiv contains the equivalent instant serialized in UTC
- **THEN** deterministic validation canonicalizes the value and preserves 14:00 Europe/Kyiv

#### Scenario: Conflicting local meaning
- **WHEN** an action declares Europe/Kyiv but its instant resolves to a different local time than the user's explicit request
- **THEN** the entire action or batch is rejected before mutation with a field-specific validation error

### Requirement: Apply bounded task batches atomically
The system SHALL support one task-only batch containing bounded combinations of task creation, task update, occurrence reschedule, and task-to-goal linking. The whole batch MUST be ownership-checked and domain-validated before mutation and MUST commit all state changes and action journal events as one recoverable unit.

#### Scenario: Create, reschedule, and link
- **WHEN** one explicit request reschedules an existing task, creates a new task, and links the new task to an existing goal
- **THEN** all steps are validated together and either all steps are applied in one action group or none are applied

#### Scenario: Multiple reschedules
- **WHEN** a user explicitly reschedules two owned task occurrences in one message
- **THEN** both optimistic versions are validated and both reschedules commit together under one action group

#### Scenario: Temporary reference to a new task
- **WHEN** a later batch step links a task created by an earlier step in the same batch
- **THEN** the batch resolves an internal temporary reference without requiring the AI to invent a database identifier

#### Scenario: One batch step is invalid
- **WHEN** any step refers to an unavailable entity, stale version, invalid time, or unsupported operation
- **THEN** no step mutates application state and the response identifies the failing step and reason

### Requirement: Use one confirmation disposition for a task batch
The system SHALL calculate confirmation requirements for every batch step before applying the batch. If any step requires confirmation, the entire batch MUST remain pending and the confirmation summary MUST enumerate all effects.

#### Scenario: Inferred link among explicit changes
- **WHEN** explicit task changes include a goal link inferred by the agent
- **THEN** the entire batch requires confirmation before any step is applied

#### Scenario: Fully explicit safe batch
- **WHEN** every task-only step is user-explicit, owned, non-destructive, and otherwise eligible for immediate application
- **THEN** the batch may apply immediately as one journal group

### Requirement: Exclude unrelated or high-risk actions from task batches
Task batches MUST NOT contain memory mutations, settings changes, provider consent, account administration, quiet-hours bypass, or unrelated entity mutations. Destructive task operations and critical-priority escalation MUST continue to follow their stricter confirmation rules.

#### Scenario: Task and memory request
- **WHEN** a single message asks to change tasks and save profile memory
- **THEN** the system does not create a mixed atomic batch and clearly separates what must be handled in another confirmed step

#### Scenario: Quiet-hours bypass
- **WHEN** a task batch includes a reminder that would bypass quiet hours without explicit authorization
- **THEN** the batch remains pending and no reminder or task mutation is applied before confirmation

### Requirement: Provide truthful batch recovery
One successful task batch SHALL expose one Undo operation that restores every reversible batch effect. If full recovery is not possible, the system MUST NOT claim that Undo succeeded and MUST surface an uncertain or non-reversible outcome.

#### Scenario: Undo mixed task batch
- **WHEN** a user invokes Undo before any affected entity version has changed
- **THEN** created tasks and links are removed, updated tasks and occurrences are restored, reminder schedules are reconciled, and the action group is marked undone

#### Scenario: Concurrent change blocks Undo
- **WHEN** an affected task changed after the batch was applied
- **THEN** Undo does not overwrite the newer state and reports that the batch can no longer be safely restored

### Requirement: Explain unsupported packages precisely
The system SHALL replace generic action failure text with a safe explanation that identifies which requested step or constraint cannot be applied. It MUST also state whether no changes were made.

#### Scenario: Unsupported exception syntax
- **WHEN** a recurrence exception is not supported
- **THEN** the response names the exception as the unsupported part and confirms that no task was created

#### Scenario: Batch validation failure
- **WHEN** structured repair still produces an invalid task batch
- **THEN** the response summarizes the rejected step without exposing raw provider payloads or sensitive message content in logs
