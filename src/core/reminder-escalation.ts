export type BriefingDeliveryStatus = "pending" | "processing" | "sent" | "ambiguous" | "failed" | "suppressed";
export type ReminderBundleDecision = "none" | "wait" | "suppress";

/** How close a reminder and a briefing must be to count as the same contact slot. */
const SAME_SLOT_TOLERANCE_MS = 60_000;
/** How long a reminder waits for the briefing of the same slot before going out on its own. */
const MAX_BUNDLE_WAIT_MS = 5 * 60_000;

export function nextCriticalEscalationAt(sentAt: Date, intervalMinutes: number): Date {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 15) {
    throw new Error("critical escalation interval must be an integer >= 15 minutes");
  }
  return new Date(sentAt.getTime() + intervalMinutes * 60_000);
}

export function reminderBriefingBundleDecision(input: {
  reminderScheduledFor: Date;
  briefingScheduledFor: Date;
  briefingStatus: BriefingDeliveryStatus;
  now: Date;
}): ReminderBundleDecision {
  if (Math.abs(input.reminderScheduledFor.getTime() - input.briefingScheduledFor.getTime()) > SAME_SLOT_TOLERANCE_MS) return "none";
  // An ambiguous digest may have reached the user; a separate reminder for the same slot risks a duplicate contact.
  if (input.briefingStatus === "sent" || input.briefingStatus === "ambiguous") return "suppress";
  if (!["pending", "processing"].includes(input.briefingStatus)) return "none";
  return input.now.getTime() - input.briefingScheduledFor.getTime() <= MAX_BUNDLE_WAIT_MS ? "wait" : "none";
}
