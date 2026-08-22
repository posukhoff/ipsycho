export function habitOfferEligible(input: {
  recurring: boolean;
  kind: "task" | "event";
  alreadyHabit: boolean;
  offeredBefore: boolean;
  behavioral: boolean;
}): boolean {
  return input.recurring
    && input.kind === "task"
    && !input.alreadyHabit
    && !input.offeredBefore
    && input.behavioral;
}
