export type TopicMode = "none" | "continue" | "new" | "switch" | "resolve";

export interface TopicDirective {
  mode: TopicMode;
  topicId: string | null;
  title: string | null;
  summary: string | null;
}

/**
 * Remove output fields that have no domain meaning for a directive variant.
 * This is schema canonicalization, not a decision override: a resolved topic
 * cannot be renamed, so a carried-over title must never block an otherwise
 * valid task/goal mutation in the same AI turn.
 */
export function canonicalizeTopicDirective<T extends TopicDirective>(directive: T): T {
  if (directive.mode === "resolve" && directive.title !== null) return { ...directive, title: null };
  return directive;
}

export function validateTopicDirective(directive: TopicDirective): string | null {
  const title = directive.title?.trim() ?? "";
  const summary = directive.summary?.trim() ?? "";
  if (directive.mode === "none") {
    return directive.topicId || title || summary ? "none topic directive must not carry topic data" : null;
  }
  if (directive.mode === "new") {
    if (directive.topicId) return "new topic must not provide topicId";
    if (!title) return "new topic requires title";
    if (!summary) return "new topic requires summary";
    return null;
  }
  if (!directive.topicId) return `${directive.mode} topic requires topicId`;
  if (!summary) return `${directive.mode} topic requires summary`;
  if (directive.mode === "resolve" && title) return "resolve topic does not rename the topic";
  return null;
}

export function memoryDisposition(input: { source: "user_explicit" | "ai_inferred"; sensitive: boolean }): "apply" | "confirm" {
  return input.source === "user_explicit" && !input.sensitive ? "apply" : "confirm";
}

export function goalLinkDisposition(input: { source: "user_explicit" | "ai_inferred"; confidence: number }): "apply" | "confirm" {
  if (input.source === "user_explicit") return "apply";
  return input.confidence >= 0.9 ? "apply" : "confirm";
}
