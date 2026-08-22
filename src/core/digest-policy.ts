import type { Importance } from "./types.js";

export type BriefingKind = "morning" | "evening" | "weekly" | "evening_weekly";

export interface DigestItem {
  id: string;
  title: string;
  importance: Importance;
  status: "scheduled" | "open" | "in_progress" | "overdue";
}

export function morningDigestSections(items: readonly DigestItem[]): {
  priority: DigestItem[];
  normal: DigestItem[];
} {
  return {
    priority: items.filter((item) => item.importance !== "normal"),
    normal: items.filter((item) => item.importance === "normal"),
  };
}

export function eveningDigestSections(items: readonly DigestItem[]): {
  decisions: DigestItem[];
  normal: DigestItem[];
} {
  return {
    decisions: items.filter((item) => item.importance === "required" || item.importance === "critical"),
    normal: items.filter((item) => item.importance === "normal"),
  };
}

export function shouldBundleWeeklyReview(input: {
  eveningDigestEnabled: boolean;
  eveningTime: string;
  weeklyReviewEnabled: boolean;
  weeklyTime: string;
  localWeekday: number;
  weeklyWeekday: number;
}): boolean {
  return input.eveningDigestEnabled
    && input.weeklyReviewEnabled
    && input.localWeekday === input.weeklyWeekday
    && input.eveningTime === input.weeklyTime;
}

export function briefingStillUseful(kind: BriefingKind, scheduledLocalDate: string, currentLocalDate: string): boolean {
  // Digests are intentionally not replayed on another local date. Weekly review may run
  // later on its intended day, but never carries into the next day either.
  return scheduledLocalDate === currentLocalDate && ["morning", "evening", "weekly", "evening_weekly"].includes(kind);
}
