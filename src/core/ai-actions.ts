import { goalLinkDisposition, memoryDisposition } from "./context-policy.js";
import type { Importance, MissPolicy, TaskKind, TimeMode } from "./types.js";
import type { StructuredLocalScheduleInput } from "./local-schedule.js";
import type { StructuredRecurrenceInput } from "./recurrence-input.js";

export type ActionSource = "user_explicit" | "ai_inferred";
export type SupportedActionType =
  | "create_task" | "update_task" | "complete_occurrence" | "reschedule_occurrence"
  | "create_goal" | "update_goal" | "save_memory" | "delete_memory" | "link_task_to_goal"
  | "create_goal_plan"
  | "update_memory"
  | "change_reminder" | "change_series" | "update_settings" | "update_occurrence" | "task_batch";

interface ActionBase { type: SupportedActionType; source: ActionSource; confidence: number; }

/** One user-facing reminder rule; shared by create_task.reminder and change_reminder.reminder. */
export interface ReminderSpecDraft {
  triggerKind: "exact" | "relative_timestamp" | "local_date";
  exactAt: string | null;
  anchor: "planned_start" | "planned_end" | "due_at" | null;
  offsetMinutes: number | null;
  daysOffset: number | null;
  localTime: string | null;
  quietPolicy: "respect" | "bypass";
}

export interface CreateTaskDraft extends ActionBase {
  type: "create_task"; criticalExplicit: boolean; habitModeExplicit: boolean; title: string; why: string | null; nextAction: string | null; context: string | null; checklist: Array<{ text: string; done: boolean }> | null;
  goalLink?: { goalId: string; expectedGoalVersion: number; confidence: number } | null;
  /** An explicit user reminder that replaces the default user reminder of the new task. */
  reminder?: ReminderSpecDraft | null;
  quietBypassExplicit?: boolean;
  definition: {
    kind: TaskKind; importance: Importance; timeMode: TimeMode; timezone: string;
    plannedStartAt: string | null; plannedEndAt: string | null; plannedLocalDate: string | null;
    dueAt: string | null; dueLocalDate: string | null; fuzzyHorizonText: string | null; reviewAt: string | null;
    localSchedule?: StructuredLocalScheduleInput | null;
    recurrenceRule: string | null; recurrenceTimezone: string | null; missPolicy: MissPolicy | null;
    recurrence?: StructuredRecurrenceInput | null;
    habitMode: boolean; minimumAction: string | null; desiredAction: string | null; habitTrigger: string | null;
  };
}

export interface UpdateTaskDraft extends ActionBase {
  type: "update_task"; taskId: string; expectedVersion: number; criticalExplicit: boolean; habitModeExplicit: boolean;
  patch: {
    title: string | null; why: string | null; nextAction: string | null; context: string | null; importance: Importance | null;
    checklist: Array<{ text: string; done: boolean }> | null;
    habitMode: boolean | null; minimumAction: string | null; desiredAction: string | null; habitTrigger: string | null;
  };
}

export interface CompleteOccurrenceDraft extends ActionBase { type: "complete_occurrence"; occurrenceId: string; expectedVersion: number; }

export interface RescheduleOccurrenceDraft extends ActionBase {
  type: "reschedule_occurrence"; occurrenceId: string; expectedVersion: number; reason: string | null;
  schedule: {
    timezone: string; plannedStartAt: string | null; plannedEndAt: string | null; plannedLocalDate: string | null;
    dueAt: string | null; dueLocalDate: string | null; fuzzyHorizonText: string | null; reviewAt: string | null;
    localSchedule?: StructuredLocalScheduleInput | null;
  };
}

export interface CreateGoalDraft extends ActionBase { type: "create_goal"; title: string; why: string | null; targetLocalDate: string | null; }
export interface CreateGoalPlanDraft extends ActionBase {
  type: "create_goal_plan";
  goal: { title: string; why: string | null; targetLocalDate: string | null };
  tasks: Array<Omit<CreateTaskDraft, "type" | "source" | "confidence" | "goalLink">>;
}
export interface UpdateGoalDraft extends ActionBase {
  type: "update_goal"; goalId: string; expectedVersion: number;
  patch: { title: string | null; why: string | null; targetLocalDate: string | null; status: "active" | "paused" | "completed" | "cancelled" | null; reviewEnabled: boolean | null };
}
export interface SaveMemoryDraft extends ActionBase { type: "save_memory"; memoryType: "note" | "decision" | "preference" | "context"; content: string; sensitive: boolean; }
export interface DeleteMemoryDraft extends ActionBase { type: "delete_memory"; memoryId: string; expectedVersion: number; }
export interface UpdateMemoryDraft extends ActionBase {
  type: "update_memory"; memoryId: string; expectedVersion: number;
  patch: { content: string | null; sensitive: boolean | null };
}
export interface LinkTaskToGoalDraft extends ActionBase { type: "link_task_to_goal"; taskId: string; expectedTaskVersion: number; goalId: string; expectedGoalVersion: number; }

export interface ChangeReminderDraft extends ActionBase {
  type: "change_reminder";
  occurrenceId: string;
  expectedVersion: number;
  mode: "add" | "replace" | "clear";
  quietBypassExplicit: boolean;
  reminder: ReminderSpecDraft | null;
}

export interface ChangeSeriesDraft extends ActionBase {
  type: "change_series";
  taskId: string;
  expectedVersion: number;
  operation: "pause" | "resume" | "stop" | "cancel" | "edit";
  edit: null | {
    timezone: string;
    recurrenceRule: string | null;
    recurrenceTimezone: string;
    missPolicy: MissPolicy | null;
    plannedStartAt: string | null;
    plannedEndAt: string | null;
    plannedLocalDate: string | null;
    dueAt: string | null;
    dueLocalDate: string | null;
    localSchedule?: StructuredLocalScheduleInput | null;
    recurrence?: StructuredRecurrenceInput | null;
  };
}
export interface UpdateSettingsDraft extends ActionBase {
  type: "update_settings";
  expectedVersion: number;
  operation: "timezone" | "language" | "digest" | "weekly_review" | "quiet_hours" | "snooze" | "reminder_defaults";
  timezone: string | null;
  applyTimezoneTo: "profile_only" | "all" | null;
  language: string | null;
  digestKind: "morning" | "evening" | null;
  enabled: boolean | null;
  time: string | null;
  weekday: number | null;
  weekdayStart: string | null;
  weekdayEnd: string | null;
  weekendStart: string | null;
  weekendEnd: string | null;
  snoozeUntil: string | null;
  eventOffsets: number[] | null;
  plannedTaskOffsetMinutes: number | null;
  criticalPostDueMinutes: number | null;
  seenNormalMinutes: number | null;
  seenRequiredMinutes: number | null;
  seenCriticalMinutes: number | null;
}
export interface UpdateOccurrenceDraft extends ActionBase {
  type: "update_occurrence";
  occurrenceId: string;
  expectedVersion: number;
  operation: "start" | "skip" | "cancel" | "seen" | "record_blocker";
  details: string | null;
}

export type TaskBatchTaskRef =
  | { kind: "persisted"; taskId: string; expectedTaskVersion: number }
  | { kind: "created"; stepId: string };

export type TaskBatchStepDraft =
  | ({ operation: "create"; stepId: string } & Omit<CreateTaskDraft, "type">)
  | ({ operation: "update"; stepId: string; target: Extract<TaskBatchTaskRef, { kind: "persisted" }> } & Omit<UpdateTaskDraft, "type" | "taskId" | "expectedVersion">)
  | ({ operation: "reschedule"; stepId: string } & Omit<RescheduleOccurrenceDraft, "type">)
  | ({ operation: "link_goal"; stepId: string; target: TaskBatchTaskRef } & Omit<LinkTaskToGoalDraft, "type" | "taskId" | "expectedTaskVersion">);

export interface TaskBatchDraft extends ActionBase {
  type: "task_batch";
  steps: TaskBatchStepDraft[];
}

export type ProposedActionDraft = CreateTaskDraft | UpdateTaskDraft | CompleteOccurrenceDraft | RescheduleOccurrenceDraft
  | CreateGoalDraft | CreateGoalPlanDraft | UpdateGoalDraft | SaveMemoryDraft | DeleteMemoryDraft | UpdateMemoryDraft | LinkTaskToGoalDraft | ChangeReminderDraft | ChangeSeriesDraft | UpdateSettingsDraft | UpdateOccurrenceDraft | TaskBatchDraft;

export type ActionDisposition = "apply" | "confirm";

export function actionDisposition(action: ProposedActionDraft): ActionDisposition {
  if (action.type === "task_batch") {
    return action.steps.some((step) => taskBatchStepDisposition(step) === "confirm") ? "confirm" : "apply";
  }
  if (action.type === "save_memory") return memoryDisposition(action);
  if (action.type === "delete_memory") return "confirm";
  // A profile edit can replace sensitive information already stored on the account.
  // The action payload cannot safely assert the prior item's sensitivity, so always confirm it.
  if (action.type === "update_memory") return "confirm";
  if (action.type === "link_task_to_goal") return goalLinkDisposition(action);
  if (action.source !== "user_explicit") return "confirm";
  if (action.type === "create_task") {
    if (action.goalLink && goalLinkDisposition({ source: "ai_inferred", confidence: action.goalLink.confidence }) === "confirm") return "confirm";
    if (action.definition.importance === "critical" && !action.criticalExplicit) return "confirm";
    if (action.definition.habitMode && !action.habitModeExplicit) return "confirm";
    if (action.reminder?.quietPolicy === "bypass" && !action.quietBypassExplicit) return "confirm";
  }
  if (action.type === "update_task") {
    if (action.patch.importance === "critical" && !action.criticalExplicit) return "confirm";
    if (action.patch.habitMode === true && !action.habitModeExplicit) return "confirm";
  }
  if (action.type === "change_reminder" && action.reminder?.quietPolicy === "bypass" && !action.quietBypassExplicit) return "confirm";
  return "apply";
}

function taskBatchStepDisposition(step: TaskBatchStepDraft): ActionDisposition {
  if (step.operation === "create") return actionDisposition({ ...step, type: "create_task" });
  if (step.operation === "update") {
    if (step.source !== "user_explicit") return "confirm";
    if (step.patch.importance === "critical" && !step.criticalExplicit) return "confirm";
    if (step.patch.habitMode === true && !step.habitModeExplicit) return "confirm";
    return "apply";
  }
  if (step.operation === "link_goal") return goalLinkDisposition(step);
  return step.source === "user_explicit" ? "apply" : "confirm";
}

export function splitActionsByDisposition(actions: readonly ProposedActionDraft[]): { immediate: ProposedActionDraft[]; pending: ProposedActionDraft[] } {
  // Multi-item task and memory extraction is one atomic user operation. Never create a
  // safe subset while waiting for confirmation on another item from the same message.
  if (actions.length > 1 && (actions.every((action) => action.type === "create_task") || actions.every((action) => action.type === "save_memory"))) {
    return actions.some((action) => actionDisposition(action) === "confirm")
      ? { immediate: [], pending: [...actions] }
      : { immediate: [...actions], pending: [] };
  }
  const immediate: ProposedActionDraft[] = []; const pending: ProposedActionDraft[] = [];
  for (const action of actions) (actionDisposition(action) === "apply" ? immediate : pending).push(action);
  return { immediate, pending };
}

export function validateActionBatchShape(actions: readonly ProposedActionDraft[]): string | null {
  if (actions.length <= 1) return null;
  if (actions.every((action) => action.type === "create_task")) return null;
  if (actions.every((action) => action.type === "save_memory")) return null;
  return "one message may create multiple tasks or memory items, but all other actions must be handled one at a time";
}

const EXPLICIT_MUTATION_WORDS = new Set([
  "напомни", "напомнить", "установи", "установить", "запланируй", "запланировать",
  "создай", "создать", "добавь", "добавить", "поставь", "поставить", "перенеси", "перенести",
  "измени", "изменить", "обнови", "обновить", "переименуй", "переименовать",
  "включи", "включить", "выключи", "выключить", "отключи", "отключить", "настрой", "настроить",
  "отметь", "отметить", "заверши", "завершить", "закрой", "закрыть", "начни", "начать",
  "пропусти", "пропустить", "отмени", "отменить", "удали", "удалить", "сохрани", "сохранить",
  "свяжи", "связать", "нагадай", "нагадати", "встанови", "встановити", "заплануй", "запланувати",
  "створи", "створити", "додай", "додати", "зміни", "змінити", "онови", "оновити",
  "перейменуй", "перейменувати", "увімкни", "увімкнути", "вимкни", "вимкнути",
  "налаштуй", "налаштувати", "познач", "позначити", "завершити", "закрий", "закрити",
  "почни", "почати", "пропустити", "скасуй", "скасувати", "видали", "видалити",
  "збережи", "зберегти", "зв'яжи", "зв’яжи", "зв'язати", "зв’язати", "remind", "set", "schedule", "create", "add",
  "reschedule", "change", "update", "rename", "enable", "disable", "mark", "complete", "close",
  "start", "skip", "cancel", "delete", "save", "link",
]);

export function containsExplicitMutationRequest(text: string): boolean {
  const words = text.match(/\p{L}+(?:['’]\p{L}+)?/gu) ?? [];
  return words.some((word) => EXPLICIT_MUTATION_WORDS.has(word)) || /(?:^|\s)turn\s+(?:on|off)(?=$|\s|[.,;:!?])/u.test(text);
}

export function isMixedTaskMutationRequest(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase();
  if (!containsExplicitMutationRequest(normalized)) return false;
  if (!/(?:задач|встреч|созвон|тренир|повтор|цель|нагад|завдан|зустріч|task|meeting|goal|recurr)/u.test(normalized)) return false;
  // Every family must match at a word start: \b is ASCII-only, so without this guard
  // "поставь" also matches the "оставь" family and a single request counts twice.
  const wordStart = "(?<![\\p{L}\\p{N}_])";
  const operationFamilies = [
    "(?:создай|создать|добавь|добавить|поставь|поставить|створи|створити|додай|додати|create|add|schedule)",
    "(?:перенеси|перенести|reschedule|перенес|переплан|переміст)",
    "(?:свяжи|связать|привяжи|привязать|зв'яжи|зв’язати|link)",
    // Only occurrence-level operations count here. Words that merely describe a
    // repeating schedule ("каждое воскресенье") belong to one task, not to a batch.
    "(?:пропусти|пропустить|пропустимо|skip|возобнови|возобновить|віднови|відновити|останови\\s+сери|зупини\\s+сері)",
    "(?:измени|изменить|обнови|обновить|оставь|оставить|зміни|онови|залиш|update|change)",
  ].map((family) => new RegExp(`${wordStart}${family}`, "u"));
  return operationFamilies.filter((pattern) => pattern.test(normalized)).length >= 2;
}

/**
 * The model cannot prove that a mutation was explicitly requested merely by
 * returning source=user_explicit. Questions and tentative suggestions require an
 * independently visible mutation request before any action may be applied.
 */
export function validateMutationIntent(actions: readonly ProposedActionDraft[], latestUserText: string, previousAssistantText?: string): string | null {
  if (actions.length === 0) return null;
  const text = latestUserText.trim().toLocaleLowerCase();
  const explicitRequest = containsExplicitMutationRequest(text);
  const isQuestion = /[?？]$/.test(text) || /^(?:как|что|когда|где|почему|зачем|можно\s+ли|будет\s+ли|як|що|коли|де|чому|навіщо|можна\s+чи|how|what|when|where|why|can\s+you|could\s+you)(?:\s|$)/u.test(text);
  const isTentative = /(?:^|[^\p{L}\p{N}_])(?:может\s+быть|наверное|возможно|стоит\s+ли|как\s+думаешь|можливо|мабуть|варто\s+чи|maybe|perhaps|should\s+i)(?=$|[^\p{L}\p{N}_])/u.test(text);
  const acceptedOffer = Boolean(previousAssistantText)
    && /^(?:да|давай|подтверждаю|согласен|согласна|так|гаразд|підтверджую|yes|ok|okay)[.!]?$/u.test(text)
    && /(?:созд|добав|измен|перенес|сохран|задач|цель|створ|додат|змін|перенест|зберег|завдан|мет|create|add|change|reschedule|save|task|goal)/iu.test(previousAssistantText ?? "");
  if (actions.some((action) => action.source === "ai_inferred") && ((!explicitRequest || isTentative) && !acceptedOffer)) {
    return "an AI-inferred proposal without an explicit user request or acceptance must remain advisory and must not create a pending action group";
  }
  if (!actions.some((action) => action.source === "user_explicit")) return null;
  if (!isQuestion && !isTentative) return null;
  return explicitRequest ? null : "an informational question or tentative suggestion without an explicit mutation request must not change application state";
}
