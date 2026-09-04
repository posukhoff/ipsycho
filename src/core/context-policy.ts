export type TopicMode = "none" | "continue" | "new" | "resolve";

/**
 * The model's topic directive never names a topic id: `continue` and `resolve` address the
 * active topic, `new` opens one, `none` pauses conversation continuity for a plain command.
 */
export interface TopicDirective {
  mode: TopicMode;
  title: string | null;
  summary: string | null;
}

/**
 * Bring a directive into a shape the context layer can always apply. A directive can
 * never block an otherwise valid turn, so an unusable one degrades instead of failing.
 */
export function normalizeTopicDirective(directive: TopicDirective, hasActiveTopic: boolean): TopicDirective {
  const title = directive.title?.trim() || null;
  const summary = directive.summary?.trim() || null;
  if (directive.mode === "none") return { mode: "none", title: null, summary: null };
  if (directive.mode === "new") {
    if (!title) return hasActiveTopic && summary ? { mode: "continue", title: null, summary } : { mode: "none", title: null, summary: null };
    return { mode: "new", title, summary: summary ?? title };
  }
  if (!hasActiveTopic) {
    if (directive.mode === "continue" && title) return { mode: "new", title, summary: summary ?? title };
    return { mode: "none", title: null, summary: null };
  }
  return { mode: directive.mode, title: directive.mode === "continue" ? title : null, summary };
}
