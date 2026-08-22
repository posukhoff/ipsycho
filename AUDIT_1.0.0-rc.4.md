# IPsycho 1.0.0-rc.4 — Telegram UX audit

## Scope

rc.4 is a presentation/orchestration pass on top of `1.0.0-rc.3-audited`. It intentionally does **not** redesign the task/reminder/AI domain model. The goal is to make the existing system faster to read and operate inside Telegram while preserving the rc.3 safety boundaries.

Compared with rc.3, the working tree adds `src/core/telegram-ux.ts`, `src/telegram/telegram-ui.ts` and `tests/core/telegram-ux.test.mjs`, and changes Telegram handlers/services, task listing, briefing rendering and review presentation. No database migration is added; migrations remain `0001`–`0013`.

## UX decisions implemented

### 1. Telegram behaves like a small application, not a command log

`/today`, `/tasks`, `/reminders` and `/settings` are compact screens. Inline navigation edits the current Telegram message when possible and falls back to a new message only when Telegram cannot edit the old one.

This reduces chat history noise without inventing persistent UI state outside Telegram.

### 2. Progressive disclosure for task actions

The primary task card shows only the frequent actions:

- `▶️ Начать`
- `✅ Готово`
- `🕒 Позже`
- `•••`

`Seen` is still supported as a legacy/internal event but is no longer a primary action. `Застрял`, cancellation and result-check scheduling are secondary actions. Once a task is in progress, result-check options are hidden behind `••• → 🔔 Проверить` instead of occupying the main keyboard.

This keeps the domain state machine intact while reducing the number of decisions visible at once.

### 3. Quick reschedule without weakening domain rules

`Позже` opens deterministic choices: `+1 час`, `Вечером`, `Завтра`, or custom input. The pure `quickRescheduleSchedule` policy preserves timezone, point/window/deadline meaning, window duration and date-only schedules.

A critical/required task, or a normal task with repeated reschedules, still requires a reason. Instead of making the quick action fail, rc.4 asks for a short second-step reason (`Не успеваю`, `Зависит от другого`, `Нет сил`, `Другое`). Compact internal callback codes keep payloads below Telegram's 64-byte limit.

Undo for a quick reschedule is attached to the updated task card rather than sent as a separate service message.

### 4. Compact daily reading

Morning/evening briefings are bounded and prioritize scanability. Morning highlights one main item and exposes a direct `Открыть день` path. Evening emphasizes unresolved required/critical decisions before optional reflection.

The task list is a compact numbered overview rather than one Telegram message per task. The Telegram task query is separate from the AI-context query and merges concrete/fuzzy tasks by importance/urgency before rendering.

### 5. Review is visually a bounded mode

The existing deterministic evening-review lifecycle is now reflected in the UI as `1/3`, `2/3`, `3/3`, then `готово`. The user gets one explicit escape action (`Закончить разбор`) rather than generic topic-management buttons during the review.

The UI metadata is presentation-only; it does not contaminate persisted assistant text/context.

### 6. Less service-message spam

Start/done/reschedule operations update the current card when possible. Reminder cancellation redraws the reminder screen. Action confirmations rely on callback toasts plus keyboard updates. Voice transcription edits its temporary `Распознаю…` message into the recognized text rather than sending another technical acknowledgement.

## Complexity review

The pass adds two small presentation helpers (`telegram-ui.ts`, `telegram-ux.ts`) rather than changing the task domain or introducing a generic UI framework. This is a good boundary: pure schedule/text policies are testable without Telegram, while grammY keyboard construction stays in the Telegram module.

The main `TelegramHandlersService` remains large (roughly 1,100 lines). rc.4 does **not** split it again merely because of line count. Voice/review orchestration and chat-reply rendering are already separate. A future split should extract a coherent command/task interaction family only when another feature or integration tests make that useful.

No Mini App, Redis, CQRS, event bus, client-side state store or workflow engine is justified for the current product.

## Bugs/risk found and fixed during the UX pass

- Date-only window tasks were initially converted into clock-time windows when choosing `Завтра`; they now remain date-only.
- Quick reschedule initially violated the existing rule requiring a reason for required/critical or repeatedly postponed tasks; the UI now adds a short reason step instead of weakening the domain rule.
- A long reason callback reached 65 bytes with a UUID and exceeded Telegram's 64-byte limit; callback values are now compact coded values.
- Opening a non-fuzzy task through a crafted `view:task:*` callback could render it using the fuzzy renderer; the detail route now enforces `timeMode=fuzzy`.
- Started tasks initially exposed all result-check timings on the main keyboard; these are now progressively disclosed under `•••`.
- Quick-reschedule Undo initially created an extra Telegram message; it is now attached to the edited task card.
- `/tasks` initially fetched too small a working set for its `+ ещё` summary; rc.4 uses a larger bounded list while rendering only the first eight entries.

## Verification performed

```text
Core deterministic tests:       126 / 126 PASS
Whole src TS syntax/transpile:   90 / 90 files PASS
Source size:                     90 TS files / 11,278 lines
Broken relative imports:         0
Import cycles:                   0
Duplicate TS source files:       0
TODO/FIXME/HACK markers:         0
Representative callback max:    58 bytes (limit 64)
package/package-lock version:    1.0.0-rc.4 consistent
```

The core suite contains the complete rc.3 regression suite plus nine focused rc.4 tests for quick-reschedule/date-only/window behavior, text compaction and review-progress presentation.

## What is not proven in this environment

A dependency-aware semantic `npm run typecheck`, `npm run build`, npm vulnerability audit, real PostgreSQL migration/run, and real Telegram/provider conformance are not marked as passed. The available runtime is Node 22 while the project requires Node 24+, and the working `node_modules` copied from the incoming archive is incomplete. Those checks remain explicit release gates in `MANUAL_ACTIONS.md`.

Dependency-independent TypeScript parsing/transpilation and deterministic core compilation/tests do pass.

## Residual product/architecture risks

The rc.3 dual-write limitations remain unchanged: inbound Telegram dedupe can lose an update if the process dies after dedupe but before completion; Telegram sends can externally succeed before their DB state is committed; and AI actions can commit before a final Telegram acknowledgement is delivered. Solving those correctly requires durable inbox/outbox integration and real PostgreSQL/Telegram tests, not a UX patch.

Settings are now button-first for common enable/disable/snooze actions, but changing exact digest/quiet-hour times still uses the existing command/text flows. This is acceptable for rc.4; adding nested time-picker flows would add callback/state complexity for a low-frequency setup action.

## Verdict

rc.4 is simpler to operate in Telegram without making the domain architecture more complicated. The important change is progressive disclosure: common actions are immediate, uncommon actions remain reachable, and most callback interactions mutate one existing card instead of creating chat noise.

Promote beyond RC only after the real Node 24 + npm + PostgreSQL + Telegram/provider checks in `MANUAL_ACTIONS.md` pass.
