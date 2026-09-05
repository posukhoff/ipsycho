import { z } from "zod";

/**
 * Model-facing contract (v2).
 *
 * Structured output (openai `zodTextFormat`, gemini `zodResponseFormat`) requires every
 * key to be present: use `.nullable()` everywhere, never `.optional()`/`.default()`, and
 * keep every object `.strict()`. The model addresses entities only by the short ids
 * (`t1`, `g2`, `m3`) the context assigned this turn; the server resolves them to UUIDs,
 * versions and the current occurrence. Nothing here carries an ISO instant.
 */

const NullableText = (max: number) => z.string().max(max).nullable();

/** `t`, `g`, `m` are ids the context assigned this turn; `n1`, `n2` … name the first, second … create_task of this message. */
export const RefSchema = z.object({ id: z.string().regex(/^[tgmn]\d{1,4}$/) }).strict();
export const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const IntentSchema = z.enum(["explicit", "inferred"]);
export const QuietSchema = z.enum(["respect", "bypass"]);

export const WhenSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("exact"), date: LocalDateSchema, time: LocalTimeSchema, durationMinutes: z.number().int().min(1).max(10080).nullable() }).strict(),
  z.object({ mode: z.literal("date"), date: LocalDateSchema }).strict(),
  z.object({ mode: z.literal("deadline"), date: LocalDateSchema, time: LocalTimeSchema.nullable() }).strict(),
  z.object({ mode: z.literal("fuzzy"), horizonText: z.string().min(1).max(200), reviewDate: LocalDateSchema }).strict(),
]);

export const RecurrenceSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly"]),
    interval: z.number().int().min(1).max(365),
    weekdays: z
      .array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]))
      .max(7)
      .nullable(),
    monthDays: z.array(z.number().int().min(1).max(31)).max(31).nullable(),
    until: LocalDateSchema.nullable(),
    skipDates: z.array(LocalDateSchema).max(32).nullable(),
    missed: z.enum(["expire", "carry_over"]).nullable(),
  })
  .strict();

export const ReminderSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), date: LocalDateSchema, time: LocalTimeSchema, quiet: QuietSchema }).strict(),
  z.object({ kind: z.literal("offset"), anchor: z.enum(["start", "end", "due"]), minutes: z.number().int().min(-10080).max(10080), quiet: QuietSchema }).strict(),
  z.object({ kind: z.literal("day"), anchor: z.enum(["start", "due"]), daysOffset: z.number().int().min(-30).max(30), time: LocalTimeSchema, quiet: QuietSchema }).strict(),
]);

export const ChecklistSchema = z.array(z.object({ text: z.string().min(1).max(300), done: z.boolean() }).strict()).max(20);
export const HabitSchema = z
  .object({
    minimumAction: z.string().min(1).max(300),
    desiredAction: z.string().min(1).max(300),
    trigger: NullableText(300),
  })
  .strict();

export const TaskBodySchema = z
  .object({
    title: z.string().min(1).max(500),
    why: NullableText(1000),
    nextAction: NullableText(500),
    context: NullableText(1000),
    checklist: ChecklistSchema.nullable(),
    importance: z.enum(["normal", "required", "critical"]),
    kind: z.enum(["task", "event"]),
    when: WhenSchema,
    recurrence: RecurrenceSchema.nullable(),
    reminder: ReminderSchema.nullable(),
    habit: HabitSchema.nullable(),
    /** Only when the user named a zone other than their own. */
    timezone: z.string().nullable(),
  })
  .strict();

const ActionBase = { intent: IntentSchema };

export const CreateTaskActionSchema = TaskBodySchema.extend({
  type: z.literal("create_task"),
  ...ActionBase,
  goal: RefSchema.nullable(),
}).strict();

export const UpdateTaskPatchSchema = z
  .object({
    title: NullableText(500),
    why: NullableText(1000),
    nextAction: NullableText(500),
    context: NullableText(1000),
    checklist: ChecklistSchema.nullable(),
    importance: z.enum(["normal", "required", "critical"]).nullable(),
    habit: z.union([HabitSchema, z.object({ enabled: z.literal(false) }).strict()]).nullable(),
  })
  .strict();

export const UpdateTaskActionSchema = z
  .object({
    type: z.literal("update_task"),
    ...ActionBase,
    task: RefSchema,
    patch: UpdateTaskPatchSchema,
  })
  .strict();

export const TaskScopeSchema = z.enum(["occurrence", "series"]);

export const SetTaskStateActionSchema = z
  .object({
    type: z.literal("set_task_state"),
    ...ActionBase,
    task: RefSchema,
    state: z.enum(["done", "started", "seen", "skipped", "cancelled"]),
    /** With state=seen: the user's concrete blocker text. */
    note: NullableText(1000),
    scope: TaskScopeSchema.nullable(),
  })
  .strict();

export const RescheduleActionSchema = z
  .object({
    type: z.literal("reschedule"),
    ...ActionBase,
    task: RefSchema,
    when: WhenSchema,
    reason: NullableText(500),
    scope: TaskScopeSchema.nullable(),
    /** Only with scope=series; null keeps the current rule. */
    recurrence: RecurrenceSchema.nullable(),
    timezone: z.string().nullable(),
  })
  .strict();

export const SetReminderActionSchema = z
  .object({
    type: z.literal("set_reminder"),
    ...ActionBase,
    task: RefSchema,
    mode: z.enum(["add", "replace", "clear"]),
    reminder: ReminderSchema.nullable(),
  })
  .strict();

export const GoalActionSchema = z
  .object({
    type: z.literal("goal"),
    ...ActionBase,
    op: z.enum(["create", "update", "link", "unlink"]),
    goal: RefSchema.nullable(),
    task: RefSchema.nullable(),
    title: NullableText(500),
    why: NullableText(1000),
    targetDate: LocalDateSchema.nullable(),
    status: z.enum(["active", "paused", "completed", "cancelled"]).nullable(),
    reviewEnabled: z.boolean().nullable(),
  })
  .strict();

export const PlanActionSchema = z
  .object({
    type: z.literal("plan"),
    ...ActionBase,
    goal: z.object({ title: z.string().min(1).max(500), why: NullableText(1000), targetDate: LocalDateSchema.nullable() }).strict(),
    tasks: z.array(TaskBodySchema).min(1).max(12),
  })
  .strict();

export const MemoryActionSchema = z
  .object({
    type: z.literal("memory"),
    ...ActionBase,
    op: z.enum(["save", "update", "delete"]),
    item: RefSchema.nullable(),
    kind: z.enum(["note", "decision", "preference", "context"]).nullable(),
    content: NullableText(2000),
    sensitive: z.boolean().nullable(),
  })
  .strict();

export const SettingsActionSchema = z
  .object({
    type: z.literal("settings"),
    ...ActionBase,
    operation: z.enum(["timezone", "language", "digest", "weekly_review", "quiet_hours", "snooze", "reminder_defaults"]),
    timezone: z.string().nullable(),
    applyTimezoneTo: z.enum(["profile_only", "all"]).nullable(),
    language: z.string().nullable(),
    digestKind: z.literal("morning").nullable(),
    enabled: z.boolean().nullable(),
    time: LocalTimeSchema.nullable(),
    weekday: z.number().int().min(1).max(7).nullable(),
    weekdayStart: LocalTimeSchema.nullable(),
    weekdayEnd: LocalTimeSchema.nullable(),
    weekendStart: LocalTimeSchema.nullable(),
    weekendEnd: LocalTimeSchema.nullable(),
    snoozeUntilDate: LocalDateSchema.nullable(),
    snoozeUntilTime: LocalTimeSchema.nullable(),
    eventOffsets: z.array(z.number().int()).max(12).nullable(),
    plannedTaskOffsetMinutes: z.number().int().nullable(),
    criticalPostDueMinutes: z.number().int().nullable(),
    seenNormalMinutes: z.number().int().nullable(),
    seenRequiredMinutes: z.number().int().nullable(),
    seenCriticalMinutes: z.number().int().nullable(),
  })
  .strict();

export const AiActionSchema = z.discriminatedUnion("type", [
  CreateTaskActionSchema,
  UpdateTaskActionSchema,
  SetTaskStateActionSchema,
  RescheduleActionSchema,
  SetReminderActionSchema,
  GoalActionSchema,
  PlanActionSchema,
  MemoryActionSchema,
  SettingsActionSchema,
]);

export const AI_ACTION_TYPES = ["create_task", "update_task", "set_task_state", "reschedule", "set_reminder", "goal", "plan", "memory", "settings"] as const;

export const TopicDirectiveSchema = z
  .object({
    mode: z.enum(["none", "continue", "new", "resolve"]),
    title: NullableText(200),
    summary: NullableText(2000),
  })
  .strict();

/**
 * What the model actually fills. One array per action kind instead of one array of a nine-branch
 * discriminated union: with the union, the model reliably *named* the right kind and then filled a
 * different, smaller branch — «напомни …» came back as `set_reminder` on a task that did not exist,
 * «закинь созвон …» as `set_task_state`. Measured with tests/eval/dialogs.json: the same model,
 * prompt and message produce the right action every time once the choice of branch is gone.
 *
 * The server flattens this back into `AiTurn.actions`, so nothing downstream sees the difference.
 */
const KindArray = <T extends z.ZodTypeAny>(schema: T, max = 8) => z.array(schema).max(max);

export const AiTurnWireSchema = z
  .object({
    reply: z.string().min(1).max(4000),
    question: NullableText(1000),
    createTasks: KindArray(CreateTaskActionSchema.omit({ type: true })),
    updateTasks: KindArray(UpdateTaskActionSchema.omit({ type: true })),
    setTaskStates: KindArray(SetTaskStateActionSchema.omit({ type: true })),
    reschedules: KindArray(RescheduleActionSchema.omit({ type: true })),
    setReminders: KindArray(SetReminderActionSchema.omit({ type: true })),
    goalOps: KindArray(GoalActionSchema.omit({ type: true })),
    plans: KindArray(PlanActionSchema.omit({ type: true }), 4),
    memories: KindArray(MemoryActionSchema.omit({ type: true })),
    settingsChanges: KindArray(SettingsActionSchema.omit({ type: true }), 4),
    topic: TopicDirectiveSchema,
  })
  .strict();

export type AiTurnWire = z.infer<typeof AiTurnWireSchema>;

/** Wire → internal. Creations come first so that n1, n2 … always resolve to a task in the same package. */
export function flattenTurn(wire: AiTurnWire): AiTurn {
  const actions = [
    ...wire.createTasks.map((body) => ({ ...body, type: "create_task" as const })),
    ...wire.plans.map((body) => ({ ...body, type: "plan" as const })),
    ...wire.goalOps.map((body) => ({ ...body, type: "goal" as const })),
    ...wire.updateTasks.map((body) => ({ ...body, type: "update_task" as const })),
    ...wire.setTaskStates.map((body) => ({ ...body, type: "set_task_state" as const })),
    ...wire.reschedules.map((body) => ({ ...body, type: "reschedule" as const })),
    ...wire.setReminders.map((body) => ({ ...body, type: "set_reminder" as const })),
    ...wire.memories.map((body) => ({ ...body, type: "memory" as const })),
    ...wire.settingsChanges.map((body) => ({ ...body, type: "settings" as const })),
  ].slice(0, 8);
  return { reply: wire.reply, question: wire.question, actions, topic: wire.topic };
}

export const AiTurnSchema = z
  .object({
    reply: z.string().min(1).max(4000),
    question: NullableText(1000),
    actions: z.array(AiActionSchema).max(8),
    topic: TopicDirectiveSchema,
  })
  .strict();

export type AiTurn = z.infer<typeof AiTurnSchema>;
export type AiAction = z.infer<typeof AiActionSchema>;
export type AiActionType = AiAction["type"];
export type Intent = z.infer<typeof IntentSchema>;
export type When = z.infer<typeof WhenSchema>;
export type Recurrence = z.infer<typeof RecurrenceSchema>;
export type Reminder = z.infer<typeof ReminderSchema>;
export type TaskBody = z.infer<typeof TaskBodySchema>;
export type UpdateTaskPatch = z.infer<typeof UpdateTaskPatchSchema>;
export type TaskScope = z.infer<typeof TaskScopeSchema>;
export type TopicDirective = z.infer<typeof TopicDirectiveSchema>;
export type SettingsAction = z.infer<typeof SettingsActionSchema>;
export type GoalAction = z.infer<typeof GoalActionSchema>;
export type MemoryAction = z.infer<typeof MemoryActionSchema>;

/**
 * Server-resolved form persisted in pending_actions.payload. Same shapes as the model
 * contract, but every reference carries the UUID and the version the resolver read.
 * Confirm re-parses stored payloads with this schema only.
 */
const Uuid = z.string().uuid();
const Version = z.number().int().positive();

export const TaskTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("occurrence"), taskId: Uuid, taskVersion: Version, occurrenceId: Uuid, occurrenceVersion: Version, timezone: z.string() }).strict(),
  z.object({ kind: z.literal("series"), taskId: Uuid, taskVersion: Version }).strict(),
  z.object({ kind: z.literal("task"), taskId: Uuid, taskVersion: Version }).strict(),
]);

const ResolvedBase = { intent: IntentSchema, timezone: z.string(), reviewTime: LocalTimeSchema };

export const ResolvedActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_task"), ...ResolvedBase, body: TaskBodySchema, goal: z.object({ goalId: Uuid, goalVersion: Version }).strict().nullable() }).strict(),
  z.object({ type: z.literal("update_task"), ...ResolvedBase, taskId: Uuid, taskVersion: Version, patch: UpdateTaskPatchSchema }).strict(),
  z.object({ type: z.literal("set_task_state"), ...ResolvedBase, target: TaskTargetSchema, state: SetTaskStateActionSchema.shape.state, note: NullableText(1000) }).strict(),
  z
    .object({ type: z.literal("reschedule"), ...ResolvedBase, target: TaskTargetSchema, when: WhenSchema, recurrence: RecurrenceSchema.nullable(), reason: NullableText(500) })
    .strict(),
  z.object({ type: z.literal("set_reminder"), ...ResolvedBase, target: TaskTargetSchema, mode: SetReminderActionSchema.shape.mode, reminder: ReminderSchema.nullable() }).strict(),
  z
    .object({
      type: z.literal("goal"),
      ...ResolvedBase,
      op: GoalActionSchema.shape.op,
      goalId: Uuid.nullable(),
      goalVersion: Version.nullable(),
      taskId: Uuid.nullable(),
      taskVersion: Version.nullable(),
      title: NullableText(500),
      why: NullableText(1000),
      targetDate: LocalDateSchema.nullable(),
      status: GoalActionSchema.shape.status,
      reviewEnabled: z.boolean().nullable(),
    })
    .strict(),
  z.object({ type: z.literal("plan"), ...ResolvedBase, goal: PlanActionSchema.shape.goal, tasks: z.array(TaskBodySchema).min(1).max(12) }).strict(),
  z
    .object({
      type: z.literal("memory"),
      ...ResolvedBase,
      op: MemoryActionSchema.shape.op,
      memoryId: Uuid.nullable(),
      memoryVersion: Version.nullable(),
      kind: MemoryActionSchema.shape.kind,
      content: NullableText(2000),
      sensitive: z.boolean().nullable(),
    })
    .strict(),
  SettingsActionSchema.omit({ intent: true })
    .extend({ ...ResolvedBase, expectedVersion: Version })
    .strict(),
]);

export type ResolvedAction = z.infer<typeof ResolvedActionSchema>;
export type TaskTarget = z.infer<typeof TaskTargetSchema>;
export type ResolvedActionOf<T extends ResolvedAction["type"]> = Extract<ResolvedAction, { type: T }>;
