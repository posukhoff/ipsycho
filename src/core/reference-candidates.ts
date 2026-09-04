import type { ActionIssue } from "./ai-actions.js";
import type { RefMap } from "./ai-refs.js";
import { searchPrefix, searchTerms } from "./search-query.js";

const MAX_CANDIDATES = 5;

/**
 * When the model names a task id the context never assigned, the server can still offer the
 * tasks whose titles share a content word with the user's message, instead of only asking
 * for "the exact title". The issue becomes a choice the user can answer in one word.
 */
export function withTaskCandidates(issues: readonly ActionIssue[], refs: RefMap, message: string): ActionIssue[] {
  const prefixes = searchTerms(message).map(searchPrefix);
  if (!prefixes.length) return [...issues];
  const candidates = [...refs.tasks.values()]
    .filter((task) => {
      const title = task.title.toLocaleLowerCase();
      return prefixes.some((prefix) => title.includes(prefix));
    })
    .slice(0, MAX_CANDIDATES)
    .map((task) => ({ id: task.id, title: task.title }));
  if (!candidates.length) return [...issues];
  return issues.map((issue) =>
    issue.kind === "reference" && issue.code === "ref_not_found" && /task/.test(issue.message)
      ? { ...issue, kind: "ambiguous" as const, code: "task_candidates", candidates }
      : issue,
  );
}
