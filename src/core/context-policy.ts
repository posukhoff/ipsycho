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
  let result = directive;
  // The model sometimes echoes a mode word ("none") or a title instead of a listed ID.
  // Such a value can never match a stored topic, so treat it as absent instead of
  // letting it reach a uuid-typed database query.
  if (result.topicId !== null && !isTopicId(result.topicId)) result = { ...result, topicId: null };
  if (result.mode === "resolve" && result.title !== null) return { ...result, title: null };
  return result;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTopicId(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
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
  if (!isTopicId(directive.topicId)) return `${directive.mode} topic requires a listed topicId, not "${directive.topicId}"`;
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
