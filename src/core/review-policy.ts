export type ReviewKind = "evening" | "weekly";

export interface ReviewClarificationDecision {
  checkpoint: boolean;
  forceConclusion: boolean;
  resolveAfterTurn: boolean;
}

export function reviewQuestionLimit(kind: ReviewKind): number {
  return kind === "weekly" ? 5 : 3;
}

export function reviewClarificationDecision(input: { kind: ReviewKind; clarificationCountBeforeTurn: number; askedQuestion: boolean }): ReviewClarificationDecision {
  const questionLimit = reviewQuestionLimit(input.kind);
  const forceConclusion = input.clarificationCountBeforeTurn >= questionLimit;
  if (forceConclusion) return { checkpoint: false, forceConclusion: true, resolveAfterTurn: true };

  const countAfterTurn = input.clarificationCountBeforeTurn + (input.askedQuestion ? 1 : 0);
  return {
    checkpoint: input.askedQuestion && countAfterTurn >= questionLimit,
    forceConclusion: false,
    resolveAfterTurn: !input.askedQuestion,
  };
}

export function reviewCorrection(kind: ReviewKind, forceConclusion = false): string {
  if (kind === "weekly") {
    if (forceConclusion) {
      return "This is the final turn of a weekly planning session after the allowed focused questions. Give a concise plan from the known context, return question=null, and do not ask anything else. Leave every action array empty: nothing is created or moved in this final summary.";
    }
    return "This is a collaborative weekly planning session. Use WEEKLY_REVIEW_SNAPSHOT and CURRENT_CONTEXT as factual sources for goals, habits, unfinished work, recent reschedules and deadlines. Help the user choose what matters next week and reconcile proposals by name with existing scheduled tasks and conflicts. Ask at most one focused question and put it in the question field, never hidden in reply. Do not create, reschedule or otherwise change tasks on your own initiative: mark your own proposals intent=inferred, and use intent=explicit only for a change the user explicitly chose. Do not save review statements as memory unless asked. Keep the existing weekly-review topic; do not open a new one.";
  }
  if (forceConclusion) {
    return "This is the final turn of an evening review after the allowed clarification questions. Answer from the known context, return question=null, and do not ask anything else. Focus on open/overdue tasks, blockers and one concrete next step. Any change you propose yourself is intent=inferred.";
  }
  return "This is an evening review. Continue the current evening-review topic; do not open a new one. Focus only on open/overdue tasks, blockers and concrete next steps. Ask at most one question. Any change you propose yourself is intent=inferred; a change the user explicitly asked for in this turn is intent=explicit.";
}

export interface ReviewPresentation {
  kind: ReviewKind;
  step?: number;
  totalSteps?: number;
  completed: boolean;
}

export function reviewPresentation(input: { kind: ReviewKind; clarificationCountBeforeTurn: number; askedQuestion: boolean }): ReviewPresentation {
  const decision = reviewClarificationDecision(input);
  const totalSteps = reviewQuestionLimit(input.kind);
  return {
    kind: input.kind,
    ...(input.askedQuestion ? { step: Math.min(totalSteps, input.clarificationCountBeforeTurn + 1), totalSteps } : {}),
    completed: decision.resolveAfterTurn,
  };
}
