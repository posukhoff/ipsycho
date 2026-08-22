import { goalLinkDisposition, memoryDisposition } from "./context-policy.js";
import type { Importance, MissPolicy, TaskKind, TimeMode } from "./types.js";

export type ActionSource = "user_explicit" | "ai_inferred";
export type SupportedActionType =
  | "create_task" | "update_task" | "complete_occurrence" | "reschedule_occurrence"
  | "create_goal" | "update_goal" | "save_memory" | "delete_memory" | "link_task_to_goal"
  | "create_goal_plan"
  | "update_memory"
  | "change_reminder" | "change_series";

interface ActionBase { type: SupportedActionType; source: ActionSource; confidence: number; }

export interface CreateTaskDraft extends ActionBase {
  type: "create_task"; criticalExplicit: boolean; habitModeExplicit: boolean; title: string; why: string | null; nextAction: string | null; context: string | null; checklist: Array<{ text: string; done: boolean }> | null;
  goalLink?: { goalId: string; expectedGoalVersion: number; confidence: number } | null;
  definition: {
    kind: TaskKind; importance: Importance; timeMode: TimeMode; timezone: string;
    plannedStartAt: string | null; plannedEndAt: string | null; plannedLocalDate: string | null;
    dueAt: string | null; dueLocalDate: string | null; fuzzyHorizonText: string | null; reviewAt: string | null;
    recurrenceRule: string | null; recurrenceTimezone: string | null; missPolicy: MissPolicy | null;
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
  reminder: null | {
    triggerKind: "exact" | "relative_timestamp" | "local_date";
    exactAt: string | null;
    anchor: "planned_start" | "planned_end" | "due_at" | null;
    offsetMinutes: number | null;
    daysOffset: number | null;
    localTime: string | null;
    quietPolicy: "respect" | "bypass";
  };
}

export interface ChangeSeriesDraft extends ActionBase {
  type: "change_series";
  taskId: string;
  expectedVersion: number;
  operation: "pause" | "resume" | "stop" | "cancel" | "edit";
  edit: null | {
    timezone: string;
    recurrenceRule: string;
    recurrenceTimezone: string;
    missPolicy: MissPolicy | null;
    plannedStartAt: string | null;
    plannedEndAt: string | null;
    plannedLocalDate: string | null;
    dueAt: string | null;
    dueLocalDate: string | null;
  };
}

export type ProposedActionDraft = CreateTaskDraft | UpdateTaskDraft | CompleteOccurrenceDraft | RescheduleOccurrenceDraft
  | CreateGoalDraft | CreateGoalPlanDraft | UpdateGoalDraft | SaveMemoryDraft | DeleteMemoryDraft | UpdateMemoryDraft | LinkTaskToGoalDraft | ChangeReminderDraft | ChangeSeriesDraft;

export type ActionDisposition = "apply" | "confirm";

export function actionDisposition(action: ProposedActionDraft): ActionDisposition {
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
  }
  if (action.type === "update_task") {
    if (action.patch.importance === "critical" && !action.criticalExplicit) return "confirm";
    if (action.patch.habitMode === true && !action.habitModeExplicit) return "confirm";
  }
  if (action.type === "change_reminder" && action.reminder?.quietPolicy === "bypass" && !action.quietBypassExplicit) return "confirm";
  return "apply";
}

export function splitActionsByDisposition(actions: readonly ProposedActionDraft[]): { immediate: ProposedActionDraft[]; pending: ProposedActionDraft[] } {
  // Multi-task extraction is one atomic user operation. Never create a safe subset while
  // waiting for confirmation on another item from the same message.
  if (actions.length > 1 && actions.every((action) => action.type === "create_task")) {
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
  return "one message may create multiple tasks, but all other actions must be handled one at a time";
}
