## Purpose

Defines how IPsycho selects persisted goals and grounds analysis, prioritization, and planning advice in the user's actual goal and task state.

## ADDED Requirements

### Requirement: Resolve the intended goal before analysis
The system SHALL resolve an explicit goal reference against goals owned by the current workspace. When pronouns or generic phrases could refer to more than one recent or active goal, it MUST ask one focused clarification instead of confidently selecting a goal.

#### Scenario: Explicit goal title
- **WHEN** a user asks to analyze a goal by title and one owned goal matches
- **THEN** the response analyzes that persisted goal and its linked active tasks

#### Scenario: Ambiguous “my goal” reference
- **WHEN** recent conversation mentions one aspirational goal but persisted state contains a different active goal and the user says “analyze my goal”
- **THEN** the system asks which goal the user means and performs no mutation

#### Scenario: Cross-workspace identifier
- **WHEN** an AI action or analysis reference points to a goal outside the acting workspace
- **THEN** the reference is rejected and no information about that goal is disclosed

### Requirement: Ground recommendations in persisted evidence
Goal advice SHALL distinguish persisted facts from suggestions and SHALL use the selected goal's purpose, deadline, linked tasks, timing, recurrence, current status, and known capacity where available. The system MUST NOT present invented tasks or metrics as existing state.

#### Scenario: Existing plan review
- **WHEN** a selected goal has linked outreach, interview, and preparation tasks
- **THEN** the analysis evaluates those concrete tasks, identifies gaps and conflicts by name, and labels any new metric or action as a recommendation

#### Scenario: Missing success criteria
- **WHEN** the persisted goal lacks measurable success criteria
- **THEN** the system proposes candidate leading and outcome measures without silently saving or mutating them

### Requirement: Prioritize within declared capacity
When a user asks for priorities, the system SHALL select from or explicitly relate recommendations to the selected goal and current task context. It MUST explain what is deferred and why, and MUST respect a user-provided limit such as “maximum three priorities.”

#### Scenario: Maximum three priorities
- **WHEN** the user requests at most three priorities for a selected goal
- **THEN** the response returns no more than three, maps each to existing work or an explicitly labeled proposal, and lists lower-value work to defer

#### Scenario: Advice-only request
- **WHEN** the user asks for analysis or prioritization and says not to change tasks
- **THEN** the system applies no action and does not create pending mutations

### Requirement: Calibrate causal claims and uncertainty
The system SHALL avoid asserting a single cause for weak results when available evidence supports multiple explanations. It SHALL state assumptions and propose a measurable test when diagnosis is uncertain.

#### Scenario: No outreach responses
- **WHEN** the user reports no responses but the system lacks evidence to distinguish market, offer, audience, channel, or message problems
- **THEN** the response presents plausible hypotheses and a bounded experiment instead of declaring one cause as fact
