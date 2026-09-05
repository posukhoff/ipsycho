import type { AiAction, TaskBody } from "./ai-contract.js";
import type { ActionIssue } from "./ai-actions.js";

/**
 * `n1`, `n2` … name the first, second … `create_task` of the same message. The server cannot
 * resolve such a reference before the task exists, but every change the model may want to
 * attach to a new task has a home inside `create_task` itself: its goal, reminder, schedule
 * and fields. So the referencing actions are folded into the create and disappear, and the
 * package stays atomic without a second pass over the transaction.
 */
export const NEW_TASK_REF = /^n(\d{1,4})$/;

export function isNewTaskRef(id: string): boolean {
  return NEW_TASK_REF.test(id);
}

export interface FoldedActions {
  actions: AiAction[];
  /** For each folded action, its index in the model's original array (issue indexes point there). */
  originalIndex: number[];
  issues: ActionIssue[];
}

export function foldNewTaskRefs(actions: readonly AiAction[]): FoldedActions {
  const creates: number[] = [];
  actions.forEach((action, index) => {
    if (action.type === "create_task") creates.push(index);
  });
  const merged = new Map<number, AiAction>();
  for (const index of creates) merged.set(index, actions[index]!);
  const kept: number[] = [];
  const issues: ActionIssue[] = [];

  const targetOf = (index: number, id: string): number | null => {
    const match = NEW_TASK_REF.exec(id);
    if (!match) return null;
    const position = Number(match[1]);
    const createIndex = creates[position - 1];
    if (createIndex === undefined) {
      issues.push({ kind: "reference", index, code: "ref_not_found", message: `${id} names a task this message does not create` });
      return -1;
    }
    return createIndex;
  };

  actions.forEach((action, index) => {
    const ref = referencedTask(action);
    if (ref === null) {
      kept.push(index);
      return;
    }
    const createIndex = targetOf(index, ref);
    if (createIndex === null) {
      kept.push(index);
      return;
    }
    if (createIndex < 0) return;
    const create = merged.get(createIndex) as Extract<AiAction, { type: "create_task" }>;
    switch (action.type) {
      case "goal":
        if (action.op === "link" && action.goal) {
          merged.set(createIndex, { ...create, goal: action.goal });
          return;
        }
        issues.push({
          kind: "domain",
          index,
          code: "new_task_state",
          message: "a task created in this message can only be linked to a goal, not unlinked or updated through goal",
        });
        return;
      case "set_reminder":
        merged.set(createIndex, { ...create, reminder: action.mode === "clear" ? null : action.reminder });
        return;
      case "update_task":
        merged.set(createIndex, { ...create, ...patchToBody(action.patch) });
        return;
      case "reschedule":
        merged.set(createIndex, { ...create, when: action.when, ...(action.recurrence ? { recurrence: action.recurrence } : {}) });
        return;
      case "set_task_state":
        issues.push({ kind: "domain", index, code: "new_task_state", message: "a task created in this message has no state to change yet" });
        return;
      default:
        kept.push(index);
    }
  });

  const order = [...new Set([...kept, ...creates])].sort((a, b) => a - b);
  return {
    actions: order.map((index) => merged.get(index) ?? actions[index]!),
    originalIndex: order,
    issues,
  };
}

function referencedTask(action: AiAction): string | null {
  switch (action.type) {
    case "update_task":
    case "set_task_state":
    case "reschedule":
    case "set_reminder":
      return action.task.id;
    case "goal":
      return action.task?.id ?? null;
    default:
      return null;
  }
}

function patchToBody(patch: Extract<AiAction, { type: "update_task" }>["patch"]): Partial<TaskBody> {
  const body: Partial<TaskBody> = {};
  if (patch.title !== null) body.title = patch.title;
  if (patch.why !== null) body.why = patch.why;
  if (patch.nextAction !== null) body.nextAction = patch.nextAction;
  if (patch.context !== null) body.context = patch.context;
  if (patch.checklist !== null) body.checklist = patch.checklist;
  if (patch.importance !== null) body.importance = patch.importance;
  return body;
}
