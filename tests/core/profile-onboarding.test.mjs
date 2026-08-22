import test from "node:test";
import assert from "node:assert/strict";
import { PROFILE_INVITATION_COOLDOWN_MS, profileOnboardingState } from "../../.core-dist/profile-onboarding.js";

const now = new Date("2026-08-11T12:00:00.000Z");

test("an empty profile may receive one optional invitation with the core areas", () => {
  const state = profileOnboardingState({ profileFactCount: 0, lastInvitedAt: null, now });
  assert.equal(state.canOffer, true);
  assert.deepEqual(state.suggestedAreas, ["daily_routine", "work_or_study", "relationships", "planning_preferences"]);
});

test("a recent invitation suppresses repeats even when the profile is still empty", () => {
  const state = profileOnboardingState({
    profileFactCount: 0,
    lastInvitedAt: new Date(now.getTime() - PROFILE_INVITATION_COOLDOWN_MS + 1),
    now,
  });
  assert.equal(state.canOffer, false);
});

test("the cooldown boundary is deterministic and an invalid future timestamp never permits nagging", () => {
  assert.equal(profileOnboardingState({
    profileFactCount: 1,
    lastInvitedAt: new Date(now.getTime() - PROFILE_INVITATION_COOLDOWN_MS),
    now,
  }).canOffer, true);
  assert.equal(profileOnboardingState({
    profileFactCount: 0,
    lastInvitedAt: new Date(now.getTime() + 24 * 60 * 60_000),
    now,
  }).canOffer, false);
});

test("a profile with two or more durable facts is not treated as incomplete by a crude checklist", () => {
  assert.equal(profileOnboardingState({ profileFactCount: 2, lastInvitedAt: null, now }).canOffer, false);
});
