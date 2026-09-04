import type { AiTurn, TopicDirective } from "../core/ai-contract.js";
import type { ReviewKind } from "../core/review-policy.js";

/**
 * Presentation fixes for review turns: a question the model also pasted into the reply is
 * shown once, a weekly turn that hid its question in prose gets it promoted, and a forced
 * conclusion carries no question and no actions.
 */
export function normalizeReviewPresentation(turn: AiTurn, review?: ReviewKind, forceConclusion = false): AiTurn {
  let normalized = turn;
  const question = turn.question?.trim();
  if (question) {
    const escapedQuestion = question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const duplicate = new RegExp(`(?:\\*\\*|__)?${escapedQuestion}(?:\\*\\*|__)?\\s*$`, "u");
    if (duplicate.test(turn.reply)) normalized = { ...turn, reply: turn.reply.replace(duplicate, "").trimEnd() || turn.reply };
  }
  if (review === "weekly" && forceConclusion) return { ...normalized, actions: [], question: null };
  if (review === "weekly" && !normalized.question) {
    const match = normalized.reply.match(/(?:^|\n)([^\n?]{3,}\?)\s*$/u);
    if (match?.[1]) return { ...normalized, reply: normalized.reply.slice(0, match.index).trim() || normalized.reply, question: match[1].trim() };
  }
  if (review === "evening" && forceConclusion) return { ...normalized, question: null };
  return normalized;
}

/** A review turn always develops the review topic, whatever the model proposed. */
export function reviewTopicDirective(directive: TopicDirective, content: string, kind: ReviewKind): TopicDirective {
  return {
    mode: "continue",
    title: null,
    summary: directive.summary?.trim() || `${kind === "weekly" ? "Планирование недели" : "Вечерний разбор"}: ${content.trim().slice(0, 500)}`,
  };
}

export function ensureAssumptionsLabel(reply: string): string {
  const cleaned = removeDanglingContinuation(reply);
  return /предполож|assum|припущ/iu.test(cleaned) ? cleaned : `${cleaned}\n\nДопущения: недостающие ограничения оценены по текущему контексту и требуют проверки.`;
}

export function removeDanglingContinuation(reply: string): string {
  return reply.replace(/(?:\s|\n)*(?:если хочешь|if you want|якщо хочеш)[\s\S]*$/iu, "").trim();
}
