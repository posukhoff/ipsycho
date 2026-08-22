export const PROFILE_INVITATION_COOLDOWN_MS = 30 * 24 * 60 * 60_000;

export interface ProfileOnboardingState {
  /** The model may make one optional invitation in this turn. */
  canOffer: boolean;
  profileFactCount: number;
  lastInvitedAt: string | null;
  suggestedAreas: readonly ["daily_routine", "work_or_study", "relationships", "planning_preferences"];
}

/**
 * A sparse profile is useful to improve, but it must never become a nagging
 * onboarding funnel. The clock is durable in user settings; a future clock
 * value is deliberately treated as recent, not as permission to spam.
 */
export function profileOnboardingState(input: {
  profileFactCount: number;
  lastInvitedAt: Date | null;
  now: Date;
}): ProfileOnboardingState {
  const lastInvitedMs = input.lastInvitedAt?.getTime();
  const invitationIsRecent = lastInvitedMs !== undefined
    && lastInvitedMs > input.now.getTime() - PROFILE_INVITATION_COOLDOWN_MS;
  return {
    canOffer: input.profileFactCount <= 1 && !invitationIsRecent,
    profileFactCount: input.profileFactCount,
    lastInvitedAt: input.lastInvitedAt?.toISOString() ?? null,
    suggestedAreas: ["daily_routine", "work_or_study", "relationships", "planning_preferences"],
  };
}
