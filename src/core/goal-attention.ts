/**
 * Goals used to have no accountability at all: `goals.review_enabled` was written and never read,
 * so a goal could sit untouched for months and nothing in the product ever mentioned it. The week
 * card is where that surfaces — not as a reminder, but as one line saying nothing has happened,
 * with an offer to work out the next step.
 */

/** How long a goal may go without any movement before the week card mentions it. */
export const GOAL_IDLE_DAYS = 21;

/** How many idle goals one card may name; more than this is a list, not a nudge. */
export const GOAL_ATTENTION_LIMIT = 3;

export interface GoalActivity {
  id: string;
  title: string;
  reviewEnabled: boolean;
  /** The newest of: the goal's own change, a linked task's change, a linked task completion. */
  lastActivityAt: Date;
}

export interface IdleGoal {
  id: string;
  title: string;
  idleDays: number;
}

export function idleDays(lastActivityAt: Date, now: Date): number {
  return Math.floor((now.getTime() - lastActivityAt.getTime()) / 86_400_000);
}

/**
 * The goals worth mentioning, longest idle first. A goal with review turned off is left alone: the
 * user said they do not want to be asked about it.
 */
export function idleGoals(rows: readonly GoalActivity[], now: Date, thresholdDays = GOAL_IDLE_DAYS): IdleGoal[] {
  return rows
    .filter((row) => row.reviewEnabled)
    .map((row) => ({ id: row.id, title: row.title, idleDays: idleDays(row.lastActivityAt, now) }))
    .filter((row) => row.idleDays >= thresholdDays)
    .sort((a, b) => b.idleDays - a.idleDays || a.title.localeCompare(b.title))
    .slice(0, GOAL_ATTENTION_LIMIT);
}
