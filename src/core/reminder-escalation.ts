export type BriefingDeliveryStatus = "pending" | "processing" | "sent" | "failed" | "suppressed";
export type ReminderBundleDecision = "none" | "wait" | "suppress";

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
  toleranceMs?: number;
  maxWaitMs?: number;
}): ReminderBundleDecision {
  const tolerance = input.toleranceMs ?? 60_000;
  if (Math.abs(input.reminderScheduledFor.getTime() - input.briefingScheduledFor.getTime()) > tolerance) return "none";
  if (input.briefingStatus === "sent") return "suppress";
  if (!['pending', 'processing'].includes(input.briefingStatus)) return "none";
  const maxWait = input.maxWaitMs ?? 5 * 60_000;
  return input.now.getTime() - input.briefingScheduledFor.getTime() <= maxWait ? "wait" : "none";
}
