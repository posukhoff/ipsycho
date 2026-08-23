import type { TaskBatchDraft, TaskBatchStepDraft } from "./ai-actions.js";

export interface CompiledTaskBatch {
  steps: readonly TaskBatchStepDraft[];
  createdStepIds: ReadonlySet<string>;
  summaries: readonly string[];
}

export class TaskBatchCompileError extends Error {
  constructor(readonly stepId: string | null, message: string) {
    super(stepId ? `step ${stepId}: ${message}` : message);
    this.name = "TaskBatchCompileError";
  }
}

export function compileTaskBatchShape(batch: TaskBatchDraft): CompiledTaskBatch {
  if (batch.steps.length < 1 || batch.steps.length > 12) throw new TaskBatchCompileError(null, "task batch must contain 1 to 12 steps");
  const seen = new Set<string>();
  const created = new Set<string>();
  const summaries: string[] = [];
  for (const step of batch.steps) {
    if (!step.stepId.trim()) throw new TaskBatchCompileError(null, "stepId is required");
    if (seen.has(step.stepId)) throw new TaskBatchCompileError(step.stepId, "stepId must be unique");
    seen.add(step.stepId);
    if (step.operation === "create") {
      created.add(step.stepId);
      summaries.push(`Создать «${step.title}»`);
      continue;
    }
    if (step.operation === "update" || step.operation === "link_goal") {
      if (step.target.kind === "created" && !created.has(step.target.stepId)) {
        throw new TaskBatchCompileError(step.stepId, `temporary task reference ${step.target.stepId} must point to an earlier create step`);
      }
      summaries.push(step.operation === "update"
        ? (step.patch.title !== null ? `Изменить задачу: название → «${step.patch.title}»` : "Изменить задачу")
        : "Связать задачу с целью");
      continue;
    }
    const start = step.schedule.localSchedule?.startDate ?? step.schedule.localSchedule?.dueDate;
    const time = step.schedule.localSchedule?.startTime ?? step.schedule.localSchedule?.dueTime;
    summaries.push(start ? `Перенести задачу на ${start.split("-").slice(1).reverse().join(".")}${time ? ` ${time}` : ""}` : "Перенести задачу");
  }
  return { steps: [...batch.steps], createdStepIds: created, summaries };
}
