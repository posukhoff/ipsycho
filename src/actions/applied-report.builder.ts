import type { ResolvedAction, ResolvedActionOf } from "../core/ai-contract.js";
import type { AppliedReportItem } from "../core/applied-report.js";
import type { ReminderSchedulingService } from "../reminders/reminder-scheduling.service.js";
import type { TasksService } from "../tasks/tasks.service.js";
import type { ActionGroupStepResult } from "./action-group.repository.js";

export interface ReportDeps {
  tasks: Pick<TasksService, "findCurrentOccurrences">;
  reminders: Pick<ReminderSchedulingService, "nextUserReminderAtMany">;
}

/**
 * The user-facing report is built from what the repositories stored, never from the model: the
 * titles, schedules and reminder times below are read back after the transaction committed.
 */
export async function buildAppliedReport(
  steps: readonly ActionGroupStepResult[],
  scope: { workspaceId: string },
  actions: readonly ResolvedAction[],
  deps: ReportDeps,
): Promise<AppliedReportItem[]> {
  // Two queries for the whole package instead of two to four per created task.
  const createdTaskIds = steps.flatMap((step) => (step.kind === "create_task" ? [step.taskId] : step.kind === "goal_plan" ? step.taskIds : []));
  const occurrences = await deps.tasks.findCurrentOccurrences(scope.workspaceId, createdTaskIds).catch(() => new Map<string, never>());
  const occurrenceIds = new Set<string>([...occurrences.values()].map((occurrence) => occurrence.id));
  for (const step of steps) {
    if (step.kind === "reschedule_occurrence" || step.kind === "concretise_task" || step.kind === "change_reminder") occurrenceIds.add(step.occurrenceId);
  }
  const reminders = await deps.reminders.nextUserReminderAtMany(scope.workspaceId, [...occurrenceIds]).catch(() => new Map<string, Date>());
  const scheduleForTask = (taskId: string) => {
    const occurrence = occurrences.get(taskId);
    if (!occurrence) return null;
    return {
      timezone: occurrence.timezone,
      plannedStartAt: occurrence.plannedStartAt ?? null,
      plannedEndAt: occurrence.plannedEndAt ?? null,
      plannedLocalDate: occurrence.plannedLocalDate ?? null,
      dueAt: occurrence.dueAt ?? null,
      dueLocalDate: occurrence.dueLocalDate ?? null,
    };
  };
  const reminderForTask = (taskId: string) => {
    const occurrence = occurrences.get(taskId);
    return occurrence ? (reminders.get(occurrence.id) ?? null) : null;
  };
  const reminderForOccurrence = (occurrenceId: string) => reminders.get(occurrenceId) ?? null;
  const items: AppliedReportItem[] = [];
  for (const step of steps) {
    switch (step.kind) {
      case "create_task": {
        const created = actions.find((action): action is ResolvedActionOf<"create_task"> => action.type === "create_task" && action.body.title.trim() === step.title);
        items.push({
          kind: "task_created",
          title: step.title,
          timezone: created?.timezone ?? "UTC",
          ...(created ? { importance: created.body.importance, recurring: Boolean(created.body.recurrence) } : {}),
          schedule: scheduleForTask(step.taskId),
          fuzzyHorizonText: created?.body.when.mode === "fuzzy" ? created.body.when.horizonText : null,
          reminderAt: reminderForTask(step.taskId),
          goalTitle: step.goalTitle,
        });
        break;
      }
      case "goal_plan":
        items.push({
          kind: "goal_plan",
          goalTitle: step.goalTitle,
          tasks: step.taskIds.map((taskId, index) => ({
            kind: "task_created" as const,
            title: step.taskTitles[index] ?? "",
            timezone: actions.find((action) => action.type === "plan")?.timezone ?? "UTC",
            schedule: scheduleForTask(taskId),
            reminderAt: reminderForTask(taskId),
          })),
        });
        break;
      case "update_task":
        items.push({ kind: "task_updated", title: step.title, changes: step.changes });
        break;
      case "update_occurrence":
        items.push({ kind: "occurrence", title: step.title, operation: step.operation });
        break;
      case "occurrence_interaction":
        items.push({ kind: "occurrence", title: step.title, operation: step.operation === "seen" ? "seen" : "record_blocker", details: step.details });
        break;
      case "complete_task":
        items.push({ kind: "occurrence", title: step.title, operation: "done" });
        break;
      case "cancel_task":
        items.push({ kind: "occurrence", title: step.title, operation: "cancel" });
        break;
      case "reschedule_occurrence":
        items.push({
          kind: "task_rescheduled",
          title: step.title,
          before: step.previousSchedule,
          after: step.occurrenceSchedule,
          reminderAt: reminderForOccurrence(step.occurrenceId),
          reason: step.reason,
        });
        break;
      case "concretise_task":
        items.push({
          kind: "task_rescheduled",
          title: step.title,
          before: null,
          after: step.occurrenceSchedule,
          reminderAt: reminderForOccurrence(step.occurrenceId),
          reason: step.reason,
          fromFuzzy: step.previousFuzzyHorizonText,
        });
        break;
      case "change_reminder":
        items.push({
          kind: "reminder",
          title: step.title,
          mode: step.mode,
          schedule: step.occurrenceSchedule,
          reminderAt: reminderForOccurrence(step.occurrenceId),
        });
        break;
      case "change_series":
        items.push({ kind: "series", title: step.title, operation: step.operation });
        break;
      case "create_goal":
        items.push({ kind: "goal_created", title: step.title });
        break;
      case "update_goal":
        items.push({ kind: "goal_updated", title: step.title });
        break;
      case "link_task_to_goal":
        items.push({ kind: "goal_linked", taskTitle: step.taskTitle, goalTitle: step.goalTitle });
        break;
      case "unlink_task_to_goal":
        items.push({ kind: "goal_unlinked", taskTitle: step.taskTitle, goalTitle: step.goalTitle });
        break;
      case "save_memory":
        items.push({ kind: "memory", operation: "saved", content: step.content });
        break;
      case "update_memory":
        items.push({ kind: "memory", operation: "updated", content: step.content });
        break;
      case "delete_memory":
        items.push({ kind: "memory", operation: "deleted", content: step.content });
        break;
      case "update_settings":
        if (step.operation) items.push({ kind: "settings", operation: step.operation });
        break;
    }
  }
  return items;
}
