export type BriefingKind = "morning" | "weekly";

/**
 * A briefing is never replayed on another local date: the morning card is about today, and the week
 * card is about the week that starts on its own day.
 */
export function briefingStillUseful(scheduledLocalDate: string, currentLocalDate: string): boolean {
  return scheduledLocalDate === currentLocalDate;
}
