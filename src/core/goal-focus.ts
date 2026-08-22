export interface GoalFocusCandidate {
  goalId: string;
  goalVersion: number;
  title: string;
  status: string;
}

export interface GoalFocusResolution {
  requested: boolean;
  state: "none" | "selected" | "ambiguous";
  selected?: GoalFocusCandidate;
  candidates: GoalFocusCandidate[];
}

const GOAL_REQUEST = /(?:\bgoal\b|\bgoals\b|цел(?:ь|и|ью|ей)|мет(?:а|у|и)|пріоритет|приоритет|analy[sz]|проанализ|розбери)/iu;
const GENERIC_GOAL = /(?:мо[яюей]\s+цел|мо[яю]\s+мет|my\s+goal|эту\s+цел|цю\s+мет|главн\w*\s+цел)/iu;

export function resolveGoalFocus(query: string, goals: readonly GoalFocusCandidate[], recentText: readonly string[] = []): GoalFocusResolution {
  const requested = GOAL_REQUEST.test(query);
  if (!requested) return { requested: false, state: "none", candidates: [] };
  const normalizedQuery = normalize(query);
  const exact = goals.filter((goal) => normalizedQuery.includes(normalize(goal.title)));
  if (exact.length === 1) return { requested: true, state: "selected", selected: exact[0]!, candidates: exact };
  if (exact.length > 1) return { requested: true, state: "ambiguous", candidates: exact };

  const recent = recentText.map(normalize).join(" ");
  const recentMatches = goals.filter((goal) => recent.includes(normalize(goal.title)));
  const active = goals.filter((goal) => goal.status === "active");
  const candidates = uniqueGoals([...recentMatches, ...active]);
  if (GENERIC_GOAL.test(query)) {
    if (candidates.length === 1) return { requested: true, state: "selected", selected: candidates[0]!, candidates };
    return { requested: true, state: "ambiguous", candidates };
  }
  return { requested: true, state: candidates.length === 1 ? "selected" : "ambiguous", ...(candidates.length === 1 ? { selected: candidates[0]! } : {}), candidates };
}

function normalize(value: string): string { return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function uniqueGoals(goals: readonly GoalFocusCandidate[]): GoalFocusCandidate[] { return [...new Map(goals.map((goal) => [goal.goalId, goal])).values()]; }
