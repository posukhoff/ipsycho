export interface HistoryMessage { role: "user" | "assistant"; content: string }

/** Longest single history message the model receives; a digest-sized reply is not worth its tokens later. */
export const HISTORY_MESSAGE_MAX_CHARS = 1_500;
/** Total history characters; the oldest messages go first when the budget is exceeded. */
export const HISTORY_TOTAL_MAX_CHARS = 12_000;

/**
 * Bounds what the model rereads every turn. Nothing else capped the history: nineteen
 * messages of up to 3 900 characters each could outweigh the prompt and the context together.
 */
export function budgetHistory<T extends HistoryMessage>(messages: readonly T[], limits = { perMessage: HISTORY_MESSAGE_MAX_CHARS, total: HISTORY_TOTAL_MAX_CHARS }): T[] {
  const trimmed = messages.map((message) => ({
    ...message,
    content: message.content.length > limits.perMessage ? `${message.content.slice(0, limits.perMessage - 1).trimEnd()}…` : message.content,
  }));
  let total = trimmed.reduce((sum, message) => sum + message.content.length, 0);
  let start = 0;
  while (total > limits.total && start < trimmed.length - 1) {
    total -= trimmed[start]!.content.length;
    start += 1;
  }
  return trimmed.slice(start);
}
