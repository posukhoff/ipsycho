export interface AvoidanceSignals {
  reschedules: number;
  seenWithoutStart: number;
  ignoredStartChecks: number;
}

export interface AvoidanceAssessment {
  detected: boolean;
  reasons: Array<"repeated_reschedule" | "repeated_seen" | "ignored_start_checks">;
}

export function deriveAvoidanceSignals(eventTypes: readonly string[]): AvoidanceSignals {
  const signals: AvoidanceSignals = { reschedules: 0, seenWithoutStart: 0, ignoredStartChecks: 0 };
  for (const type of eventTypes) {
    if (type === "occurrence:rescheduled") signals.reschedules += 1;
    if (type === "occurrence:seen") signals.seenWithoutStart += 1;
    if (type === "occurrence:start_check_ignored" || type === "occurrence:result_check_ignored") signals.ignoredStartChecks += 1;
    if (type === "occurrence:in_progress") {
      signals.seenWithoutStart = 0;
      signals.ignoredStartChecks = 0;
    }
  }
  return signals;
}

export function assessAvoidance(signals: AvoidanceSignals): AvoidanceAssessment {
  const reasons: AvoidanceAssessment["reasons"] = [];
  if (signals.reschedules >= 2) reasons.push("repeated_reschedule");
  if (signals.seenWithoutStart >= 2) reasons.push("repeated_seen");
  if (signals.ignoredStartChecks >= 2) reasons.push("ignored_start_checks");
  return { detected: reasons.length > 0, reasons };
}
