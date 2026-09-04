import type { ResolvedAction } from "./ai-contract.js";

export type { ResolvedAction, ResolvedActionOf, TaskTarget, AiAction, Intent } from "./ai-contract.js";

/**
 * Why an action from the model cannot be applied. `kind` picks the reply strategy in the
 * chat layer; `code` picks the sentence; `candidates` feed a deterministic clarification.
 */
export interface ActionIssue {
  kind: "schema" | "reference" | "ambiguous" | "domain";
  /** Position in the model's `actions` array. */
  index: number;
  code: string;
  message: string;
  candidates?: Array<{ id: string; title: string }>;
}

export type ActionDisposition = "apply" | "confirm";

/**
 * Baseline v10 §3.2, computed on the server from the action alone. The model contributes
 * one bit (`intent`); Undo and the confirmation card absorb the cases it gets wrong.
 */
export function disposition(action: ResolvedAction): ActionDisposition {
  if (alwaysConfirm(action)) return "confirm";
  return action.intent === "explicit" ? "apply" : "confirm";
}

function alwaysConfirm(action: ResolvedAction): boolean {
  switch (action.type) {
    case "create_task":
      return action.body.importance === "critical" || action.body.habit !== null || action.body.reminder?.quiet === "bypass";
    case "plan":
      return action.tasks.some((task) => task.importance === "critical" || task.habit !== null || task.reminder?.quiet === "bypass");
    case "update_task":
      return action.patch.importance === "critical" || (action.patch.habit !== null && "minimumAction" in action.patch.habit);
    case "set_task_state":
      return action.state === "cancelled" || action.state === "skipped";
    case "set_reminder":
      return action.reminder?.quiet === "bypass";
    case "goal":
      return action.op === "update" && action.status === "cancelled";
    case "memory":
      return action.op !== "save" || action.sensitive === true;
    case "reschedule":
    case "settings":
      return false;
  }
}

/** One message is one package: a single confirmation card or a single applied group. */
export function groupDisposition(actions: readonly ResolvedAction[]): ActionDisposition {
  return actions.some((action) => disposition(action) === "confirm") ? "confirm" : "apply";
}

/** Only `seen` records nothing the user would want to roll back. */
export function isUndoable(actions: readonly ResolvedAction[]): boolean {
  return !actions.every((action) => action.type === "set_task_state" && action.state === "seen");
}
