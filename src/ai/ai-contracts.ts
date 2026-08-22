import { z } from "zod";

const NullableString = z.string().nullable();
const ActionSourceSchema = z.enum(["user_explicit", "ai_inferred"]);
const ConfidenceSchema = z.number().min(0).max(1);

export const TaskDefinitionDraftSchema = z.object({
  kind: z.enum(["task", "event"]),
  importance: z.enum(["normal", "required", "critical"]),
  timeMode: z.enum(["point", "window", "deadline", "fuzzy"]),
  timezone: z.string().min(1),
  plannedStartAt: NullableString,
  plannedEndAt: NullableString,
  plannedLocalDate: NullableString,
  dueAt: NullableString,
  dueLocalDate: NullableString,
  fuzzyHorizonText: NullableString,
  reviewAt: NullableString,
  recurrenceRule: NullableString,
  recurrenceTimezone: NullableString,
  missPolicy: z.enum(["expire", "carry_over"]).nullable(),
  habitMode: z.boolean(),
  minimumAction: NullableString,
  desiredAction: NullableString,
  habitTrigger: NullableString,
});

export const CreateTaskActionSchema = z.object({
  type: z.literal("create_task"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  criticalExplicit: z.boolean(),
  habitModeExplicit: z.boolean(),
  title: z.string().min(1).max(500),
  why: NullableString,
  nextAction: NullableString,
  context: NullableString,
  checklist: z.array(z.object({ text: z.string().min(1).max(300), done: z.boolean() })).max(20).nullable(),
  goalLink: z.object({ goalId: z.string().uuid(), expectedGoalVersion: z.number().int().positive(), confidence: ConfidenceSchema }).nullable(),
  definition: TaskDefinitionDraftSchema,
});

export const CreateGoalPlanActionSchema = z.object({
  type: z.literal("create_goal_plan"), source: ActionSourceSchema, confidence: ConfidenceSchema,
  goal: z.object({ title: z.string().min(1).max(500), why: NullableString, targetLocalDate: NullableString }),
  tasks: z.array(CreateTaskActionSchema.omit({ type: true, source: true, confidence: true, goalLink: true })).min(1).max(12),
});

export const UpdateTaskActionSchema = z.object({
  type: z.literal("update_task"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  taskId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  criticalExplicit: z.boolean(),
  habitModeExplicit: z.boolean(),
  patch: z.object({
    title: z.string().min(1).max(500).nullable(),
    why: NullableString,
    nextAction: NullableString,
    context: NullableString,
    importance: z.enum(["normal", "required", "critical"]).nullable(),
    checklist: z.array(z.object({ text: z.string().min(1).max(300), done: z.boolean() })).max(20).nullable(),
    habitMode: z.boolean().nullable(),
    minimumAction: NullableString,
    desiredAction: NullableString,
    habitTrigger: NullableString,
  }),
});

export const CompleteOccurrenceActionSchema = z.object({
  type: z.literal("complete_occurrence"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  occurrenceId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});

export const RescheduleOccurrenceActionSchema = z.object({
  type: z.literal("reschedule_occurrence"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  occurrenceId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  reason: NullableString,
  schedule: z.object({
    timezone: z.string().min(1),
    plannedStartAt: NullableString,
    plannedEndAt: NullableString,
    plannedLocalDate: NullableString,
    dueAt: NullableString,
    dueLocalDate: NullableString,
    fuzzyHorizonText: NullableString,
    reviewAt: NullableString,
  }),
});

export const CreateGoalActionSchema = z.object({
  type: z.literal("create_goal"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  title: z.string().min(1).max(500),
  why: NullableString,
  targetLocalDate: NullableString,
});

export const UpdateGoalActionSchema = z.object({
  type: z.literal("update_goal"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  goalId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  patch: z.object({
    title: z.string().min(1).max(500).nullable(),
    why: NullableString,
    targetLocalDate: NullableString,
    status: z.enum(["active", "paused", "completed", "cancelled"]).nullable(),
    reviewEnabled: z.boolean().nullable(),
  }),
});

export const SaveMemoryActionSchema = z.object({
  type: z.literal("save_memory"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  memoryType: z.enum(["note", "decision", "preference", "context"]),
  content: z.string().min(1).max(2000),
  sensitive: z.boolean(),
});

export const DeleteMemoryActionSchema = z.object({
  type: z.literal("delete_memory"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  memoryId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});

export const UpdateMemoryActionSchema = z.object({
  type: z.literal("update_memory"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  memoryId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  patch: z.object({ content: NullableString, sensitive: z.boolean().nullable() }),
});

export const LinkTaskToGoalActionSchema = z.object({
  type: z.literal("link_task_to_goal"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  taskId: z.string().uuid(),
  expectedTaskVersion: z.number().int().positive(),
  goalId: z.string().uuid(),
  expectedGoalVersion: z.number().int().positive(),
});


export const ChangeReminderActionSchema = z.object({
  type: z.literal("change_reminder"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  occurrenceId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  mode: z.enum(["add", "replace", "clear"]),
  quietBypassExplicit: z.boolean(),
  reminder: z.object({
    triggerKind: z.enum(["exact", "relative_timestamp", "local_date"]),
    exactAt: NullableString,
    anchor: z.enum(["planned_start", "planned_end", "due_at"]).nullable(),
    offsetMinutes: z.number().int().nullable(),
    daysOffset: z.number().int().nullable(),
    localTime: NullableString,
    quietPolicy: z.enum(["respect", "bypass"]),
  }).nullable(),
});

export const ChangeSeriesActionSchema = z.object({
  type: z.literal("change_series"), source: ActionSourceSchema, confidence: ConfidenceSchema,
  taskId: z.string().uuid(), expectedVersion: z.number().int().positive(),
  operation: z.enum(["pause", "resume", "stop", "cancel", "edit"]),
  edit: z.object({
    timezone: z.string().min(1),
    recurrenceRule: z.string().min(1),
    recurrenceTimezone: z.string().min(1),
    missPolicy: z.enum(["expire", "carry_over"]).nullable(),
    plannedStartAt: NullableString,
    plannedEndAt: NullableString,
    plannedLocalDate: NullableString,
    dueAt: NullableString,
    dueLocalDate: NullableString,
  }).nullable(),
});

export const ProposedActionSchema = z.discriminatedUnion("type", [
  CreateTaskActionSchema,
  UpdateTaskActionSchema,
  CompleteOccurrenceActionSchema,
  RescheduleOccurrenceActionSchema,
  CreateGoalActionSchema,
  CreateGoalPlanActionSchema,
  UpdateGoalActionSchema,
  SaveMemoryActionSchema,
  DeleteMemoryActionSchema,
  UpdateMemoryActionSchema,
  LinkTaskToGoalActionSchema,
  ChangeReminderActionSchema,
  ChangeSeriesActionSchema,
]);

export const TopicDirectiveSchema = z.object({
  mode: z.enum(["none", "continue", "new", "switch", "resolve"]),
  topicId: NullableString,
  title: NullableString,
  summary: NullableString,
});

export const AiTurnSchema = z.object({
  reply: z.string().min(1).max(4000),
  question: NullableString,
  /** Set only when this response actually invites the user to build their profile. */
  profileInvitation: z.boolean().optional().default(false),
  topic: TopicDirectiveSchema,
  topicModeSuggestion: z.enum(["normal", "analysis"]).nullable(),
  actions: z.array(ProposedActionSchema).max(8),
});

export type AiTurn = z.infer<typeof AiTurnSchema>;
export type ProposedAction = z.infer<typeof ProposedActionSchema>;
