import type { Importance } from "./types.js";

export type BriefingKind = "morning" | "weekly";

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

export function briefingStillUseful(kind: BriefingKind, scheduledLocalDate: string, currentLocalDate: string): boolean {
  // A briefing is intentionally not replayed on another local date: the morning card is about
  // today, and the week card is about the week that starts on its own day.
  return scheduledLocalDate === currentLocalDate && ["morning", "weekly"].includes(kind);
}
