export const WEEKLY_MOVEMENT_EVENT_TYPES = ["occurrence:done", "occurrence:rescheduled"] as const;
export const WEEKLY_REVIEW_GOAL_STATUSES = ["active", "paused", "completed"] as const;

export function isWeeklyReviewGoalStatus(status: string): status is (typeof WEEKLY_REVIEW_GOAL_STATUSES)[number] {
  return WEEKLY_REVIEW_GOAL_STATUSES.includes(status as (typeof WEEKLY_REVIEW_GOAL_STATUSES)[number]);
}

export function isWeeklyMovementEvent(eventType: string): eventType is (typeof WEEKLY_MOVEMENT_EVENT_TYPES)[number] {
  return WEEKLY_MOVEMENT_EVENT_TYPES.includes(eventType as (typeof WEEKLY_MOVEMENT_EVENT_TYPES)[number]);
}

export function aggregateHistoricalGoalMovement(
  rows: readonly { goalId: string; title: string; eventType: string }[],
  activeGoalIds: ReadonlySet<string>,
): Array<{ goalId: string; title: string; done: number; rescheduled: number }> {
  const byGoal = new Map<string, { goalId: string; title: string; done: number; rescheduled: number }>();
  for (const row of rows) {
    if (activeGoalIds.has(row.goalId) || !isWeeklyMovementEvent(row.eventType)) continue;
    const fact = byGoal.get(row.goalId) ?? { goalId: row.goalId, title: row.title, done: 0, rescheduled: 0 };
    if (row.eventType === "occurrence:done") fact.done += 1;
    else fact.rescheduled += 1;
    byGoal.set(row.goalId, fact);
  }
  return [...byGoal.values()];
}

export function habitCompletionStats(statuses: readonly string[]): { done: number; total: number; missed: number; rate: number | null } {
  const relevant = statuses.filter((status) => ["done", "skipped", "elapsed"].includes(status));
  const done = relevant.filter((status) => status === "done").length;
  const missed = relevant.length - done;
  return { done, total: relevant.length, missed, rate: relevant.length ? Math.round(done / relevant.length * 100) : null };
}
