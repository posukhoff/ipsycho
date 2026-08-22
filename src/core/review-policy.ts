export type ReviewKind = "evening" | "weekly";

export interface ReviewClarificationDecision {
  checkpoint: boolean;
  forceConclusion: boolean;
  resolveAfterTurn: boolean;
}

export function reviewClarificationDecision(input: {
  kind: ReviewKind;
  clarificationCountBeforeTurn: number;
  askedQuestion: boolean;
}): ReviewClarificationDecision {
  const forceConclusion = input.clarificationCountBeforeTurn >= 3;
  if (forceConclusion) return { checkpoint: false, forceConclusion: true, resolveAfterTurn: true };

  const countAfterTurn = input.clarificationCountBeforeTurn + (input.askedQuestion ? 1 : 0);
  return {
    checkpoint: input.askedQuestion && countAfterTurn >= 3,
    forceConclusion: false,
    resolveAfterTurn: !input.askedQuestion,
  };
}

export function reviewCorrection(kind: ReviewKind, forceConclusion = false): string {
  if (kind === "weekly") {
    if (forceConclusion) {
      return "This is the final turn of a weekly planning session after the allowed focused questions. Give a concise plan from the known context, return question=null, and do not ask anything else. Never create, reschedule, or otherwise mutate tasks in this final summary.";
    }
    return "This is a collaborative weekly planning session. Use WEEKLY_REVIEW_SNAPSHOT and CURRENT_CONTEXT as factual sources for goals, habits, unfinished work, recent reschedules and deadlines. Report evidence in reviewProgress for outcome, capacityEnergy, risks, minimumSuccess, commitments, and conclusionRequested; do not mark a dimension provided unless the user or persisted context supports its summary. Help the user choose what matters next week and reconcile proposals by name with existing scheduled tasks and conflicts. Ask at most one focused question. If more information is needed for a concrete plan, put that question in the structured question field; do not hide it in reply, say ‘if you want’, or return question=null. Never reschedule, create, or otherwise mutate tasks automatically: before the user explicitly chooses it, return actions=[]. For explicitly accepted task changes, use task_batch with source=user_explicit. Do not save weekly review statements as memory unless the user explicitly asks to remember them. Keep the existing weekly-review topic; do not switch topics.";
  }
  if (forceConclusion) {
    return "This is the final turn of an evening review after the allowed clarification questions. Answer from the known context, return question=null, and do not ask anything else. Focus on open/overdue tasks, blockers and one concrete next step. Any proposed action must be ai_inferred so it requires confirmation.";
  }
  return "This is an evening review. Continue the current listed evening-review topic; do not create or switch topics. Focus only on open/overdue tasks, blockers and concrete next steps. Ask at most one question. Any proposed action must be ai_inferred so it requires confirmation.";
}

export interface ReviewPresentation {
  kind: ReviewKind;
  step?: number;
  totalSteps?: number;
  completed: boolean;
}

export function reviewPresentation(input: {
  kind: ReviewKind;
  clarificationCountBeforeTurn: number;
  askedQuestion: boolean;
}): ReviewPresentation {
  const decision = reviewClarificationDecision(input);
  return {
    kind: input.kind,
    ...(input.askedQuestion ? { step: Math.min(3, input.clarificationCountBeforeTurn + 1), totalSteps: 3 } : {}),
    completed: decision.resolveAfterTurn,
  };
}
