## Purpose

Defines a multi-turn weekly planning review that gathers enough context to produce a realistic, capacity-aware plan without making unconfirmed changes.

## ADDED Requirements

### Requirement: Collect required weekly planning dimensions
A weekly review SHALL remain active until it has either collected or explicitly skipped: the desired weekly outcome, available capacity and energy constraints, main risks or blockers, minimum viable success, and relevant existing commitments. The user MAY explicitly request an early conclusion.

#### Scenario: First answer supplies only outcome
- **WHEN** the first review answer supplies a measurable weekly result but no capacity or risk information
- **THEN** the review remains active and asks one focused structured question for the next missing dimension

#### Scenario: User requests early conclusion
- **WHEN** the user explicitly asks the review to conclude with currently available information
- **THEN** the system returns a provisional plan, labels missing assumptions, and resolves the review

#### Scenario: Maximum clarification limit
- **WHEN** the configured clarification limit is reached with required information still missing
- **THEN** the system concludes with a best-effort plan that clearly labels assumptions rather than silently dropping the missing dimension

### Requirement: Keep review questions structurally consistent
If a weekly review response asks the user to choose or provide information, the question SHALL be present in the structured question field and the review SHALL not be marked complete in that turn.

#### Scenario: Question embedded in prose
- **WHEN** an AI response contains a continuation question only in reply prose
- **THEN** deterministic normalization extracts or repairs the question before lifecycle evaluation, or removes the question and produces a genuine conclusion

#### Scenario: No question in final answer
- **WHEN** the review is marked complete
- **THEN** the response contains no hidden “if you want” continuation question and presents the current plan as complete or explicitly provisional

### Requirement: Produce a plan grounded in current commitments
The final weekly plan SHALL reference relevant existing tasks and scheduled occurrences, identify conflicts with stated capacity or energy, define minimum viable success, and distinguish proposed moves from already persisted scheduling.

#### Scenario: Evening energy conflict
- **WHEN** an existing interview is scheduled in the evening and the user reports low evening energy
- **THEN** the plan names that task and time as a conflict and proposes a concrete alternative without applying it automatically

#### Scenario: Existing outreach already scheduled
- **WHEN** an existing task already schedules five invitations on Monday
- **THEN** a plan that redistributes invitations across the week explicitly reconciles the proposal with that existing Monday task

#### Scenario: Final plan requested
- **WHEN** the user asks for a concrete weekly plan and identifies capacity, risk, and minimum success
- **THEN** the response supplies the plan in that turn instead of deferring the useful schedule to another optional follow-up

### Requirement: Require confirmation for weekly plan mutations
Weekly planning SHALL be advisory by default. Proposed task creation, update, reschedule, or linking MUST remain unmutated until the user explicitly selects the change and any required confirmation succeeds.

#### Scenario: User asks for plan without automatic changes
- **WHEN** the user asks what to move or cancel but says not to change the schedule
- **THEN** the system returns proposals only and creates no immediate or pending action group

#### Scenario: Explicitly accepted weekly changes
- **WHEN** the user explicitly accepts a bounded set of proposed task changes
- **THEN** the system submits them through the task-batch validation, confirmation, journaling, and Undo contract

### Requirement: Do not infer durable memory from weekly review content
Statements made while evaluating the coming week SHALL NOT be stored as durable profile memory unless the user explicitly asks to remember or save them.

#### Scenario: Weekly outcome statement
- **WHEN** a user names the week's desired result during a review
- **THEN** the statement remains review context and produces no memory action

#### Scenario: Explicit remember request
- **WHEN** the user explicitly asks to remember a durable planning preference during the review
- **THEN** the memory action follows normal sensitivity, confirmation, ownership, journaling, and Undo rules independently of task planning
