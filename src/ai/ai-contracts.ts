import { z } from "zod";
import { WeeklyReviewProgressSchema } from "../core/weekly-review-state.js";

const NullableString = z.string().nullable();
const ActionSourceSchema = z.enum(["user_explicit", "ai_inferred"]);
const ConfidenceSchema = z.number().min(0).max(1);

export const StructuredLocalScheduleSchema = z.object({
  mode: z.enum(["exact", "window", "date", "deadline", "fuzzy"]),
  timezone: z.string().min(1),
  startDate: NullableString,
  startTime: NullableString,
  endDate: NullableString,
  endTime: NullableString,
  dueDate: NullableString,
  dueTime: NullableString,
  durationMinutes: z.number().int().min(1).max(10080).nullable(),
  fuzzyHorizonText: NullableString,
  reviewDate: NullableString,
  reviewTime: NullableString,
}).strict();

export const StructuredRecurrenceSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().min(1).max(365),
  startsOn: z.string(),
  endsOn: NullableString,
  weekdays: z.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])).max(7).nullable(),
  monthDays: z.array(z.number().int().min(1).max(31)).max(31).nullable(),
  localTimes: z.array(z.string()).max(16).nullable(),
  excludedLocalDates: z.array(z.string()).max(32).nullable(),
}).strict();

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
  localSchedule: StructuredLocalScheduleSchema.nullable().optional().default(null),
  recurrenceRule: NullableString,
  recurrenceTimezone: NullableString,
  recurrence: StructuredRecurrenceSchema.nullable().optional().default(null),
  missPolicy: z.enum(["expire", "carry_over"]).nullable(),
  habitMode: z.boolean(),
  minimumAction: NullableString,
  desiredAction: NullableString,
  habitTrigger: NullableString,
});

export const ReminderSpecSchema = z.object({
  triggerKind: z.enum(["exact", "relative_timestamp", "local_date"]),
  exactAt: NullableString,
  anchor: z.enum(["planned_start", "planned_end", "due_at"]).nullable(),
  offsetMinutes: z.number().int().nullable(),
  daysOffset: z.number().int().nullable(),
  localTime: NullableString,
  quietPolicy: z.enum(["respect", "bypass"]),
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
  /** Explicit user reminder for the new task; null keeps the default reminder from settings. */
  reminder: ReminderSpecSchema.nullable().optional().default(null),
  quietBypassExplicit: z.boolean().optional().default(false),
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
    localSchedule: StructuredLocalScheduleSchema.nullable().optional().default(null),
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

const TaskBatchTaskRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("persisted"), taskId: z.string().uuid(), expectedTaskVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("created"), stepId: z.string().min(1).max(64) }).strict(),
]);

const TaskBatchCreateStepSchema = CreateTaskActionSchema.omit({ type: true }).extend({
  operation: z.literal("create"), stepId: z.string().min(1).max(64),
}).strict();
const TaskBatchUpdateStepSchema = UpdateTaskActionSchema.omit({ type: true, taskId: true, expectedVersion: true }).extend({
  operation: z.literal("update"), stepId: z.string().min(1).max(64),
  target: z.object({ kind: z.literal("persisted"), taskId: z.string().uuid(), expectedTaskVersion: z.number().int().positive() }).strict(),
}).strict();
const TaskBatchRescheduleStepSchema = RescheduleOccurrenceActionSchema.omit({ type: true }).extend({
  operation: z.literal("reschedule"), stepId: z.string().min(1).max(64),
}).strict();
const TaskBatchGoalLinkStepSchema = LinkTaskToGoalActionSchema.omit({ type: true, taskId: true, expectedTaskVersion: true }).extend({
  operation: z.literal("link_goal"), stepId: z.string().min(1).max(64), target: TaskBatchTaskRefSchema,
}).strict();

export const TaskBatchActionSchema = z.object({
  type: z.literal("task_batch"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  steps: z.array(z.discriminatedUnion("operation", [
    TaskBatchCreateStepSchema, TaskBatchUpdateStepSchema, TaskBatchRescheduleStepSchema, TaskBatchGoalLinkStepSchema,
  ])).min(1).max(12),
}).strict().superRefine((batch, ctx) => {
  const seen = new Set<string>();
  for (const [index, step] of batch.steps.entries()) {
    if (seen.has(step.stepId)) ctx.addIssue({ code: "custom", path: ["steps", index, "stepId"], message: "stepId must be unique" });
    seen.add(step.stepId);
  }
});


export const ChangeReminderActionSchema = z.object({
  type: z.literal("change_reminder"),
  source: ActionSourceSchema,
  confidence: ConfidenceSchema,
  occurrenceId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  mode: z.enum(["add", "replace", "clear"]),
  quietBypassExplicit: z.boolean(),
  reminder: ReminderSpecSchema.nullable(),
});

export const ChangeSeriesActionSchema = z.object({
  type: z.literal("change_series"), source: ActionSourceSchema, confidence: ConfidenceSchema,
  taskId: z.string().uuid(), expectedVersion: z.number().int().positive(),
  operation: z.enum(["pause", "resume", "stop", "cancel", "edit"]),
  edit: z.object({
    timezone: z.string().min(1),
    recurrenceRule: NullableString,
    recurrenceTimezone: z.string().min(1),
    missPolicy: z.enum(["expire", "carry_over"]).nullable(),
    plannedStartAt: NullableString,
    plannedEndAt: NullableString,
    plannedLocalDate: NullableString,
    dueAt: NullableString,
    dueLocalDate: NullableString,
    localSchedule: StructuredLocalScheduleSchema.nullable().optional().default(null),
    recurrence: StructuredRecurrenceSchema.nullable().optional().default(null),
  }).nullable(),
});
export const UpdateSettingsActionSchema = z.object({
  type: z.literal("update_settings"), source: ActionSourceSchema, confidence: ConfidenceSchema,
  expectedVersion: z.number().int().positive(),
  operation: z.enum(["timezone", "language", "digest", "weekly_review", "quiet_hours", "snooze", "reminder_defaults"]),
  timezone: NullableString,
  applyTimezoneTo: z.enum(["profile_only", "all"]).nullable(),
  language: NullableString,
  digestKind: z.enum(["morning", "evening"]).nullable(),
  enabled: z.boolean().nullable(),
  time: NullableString,
  weekday: z.number().int().min(1).max(7).nullable(),
  weekdayStart: NullableString, weekdayEnd: NullableString,
  weekendStart: NullableString, weekendEnd: NullableString,
  snoozeUntil: NullableString,
  eventOffsets: z.array(z.number().int()).max(12).nullable(),
  plannedTaskOffsetMinutes: z.number().int().nullable(),
  criticalPostDueMinutes: z.number().int().nullable(),
  seenNormalMinutes: z.number().int().nullable(),
  seenRequiredMinutes: z.number().int().nullable(),
  seenCriticalMinutes: z.number().int().nullable(),
}).superRefine((action, ctx) => {
  if (action.operation === "timezone" && action.applyTimezoneTo === null) {
    ctx.addIssue({ code: "custom", path: ["applyTimezoneTo"], message: "timezone scope is required" });
  }
});
export const UpdateOccurrenceActionSchema = z.object({
  type: z.literal("update_occurrence"), source: ActionSourceSchema, confidence: ConfidenceSchema,
  occurrenceId: z.string().uuid(), expectedVersion: z.number().int().positive(),
  operation: z.enum(["start", "skip", "cancel", "seen", "record_blocker"]),
  details: z.string().min(1).max(1000).nullable(),
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
  UpdateSettingsActionSchema,
  UpdateOccurrenceActionSchema,
  TaskBatchActionSchema,
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
  goalAnalysisFocus: z.object({ goalId: z.string().uuid(), expectedVersion: z.number().int().positive() }).nullable().optional().default(null),
  reviewProgress: WeeklyReviewProgressSchema.nullable().optional().default(null),
  actions: z.array(ProposedActionSchema).max(8),
});

export type AiTurn = z.infer<typeof AiTurnSchema>;
export type ProposedAction = z.infer<typeof ProposedActionSchema>;
