import type { TaskStatus, TimeMode } from "./types.js";

/**
 * Per-turn map from the short ids the model sees (`t1`, `g2`, `m3`) to the entities they
 * name. Built by the context, consumed by the resolver; UUIDs never reach the model and
 * a short id from an earlier turn can never be replayed against a different entity.
 */
export interface RefEntry {
  id: string;
  version: number;
  title: string;
}
export interface TaskRefEntry extends RefEntry {
  timeMode: TimeMode;
  recurring: boolean;
  status: TaskStatus;
}

export interface RefMap {
  tasks: ReadonlyMap<string, TaskRefEntry>;
  goals: ReadonlyMap<string, RefEntry>;
  memory: ReadonlyMap<string, RefEntry>;
}

export type RefKind = keyof RefMap;

export const REF_PREFIX: Record<RefKind, "t" | "g" | "m"> = { tasks: "t", goals: "g", memory: "m" };

export const EMPTY_REFS: RefMap = { tasks: new Map(), goals: new Map(), memory: new Map() };

/** Assign `t1..tN` in the order given; callers sort by relevance first so `t1` is the nearest task. */
export function assignShortIds<T extends { id: string }>(kind: RefKind, entries: readonly T[]): Array<T & { shortId: string }> {
  return entries.map((entry, index) => ({ ...entry, shortId: `${REF_PREFIX[kind]}${index + 1}` }));
}

export function buildRefMap(input: {
  tasks: ReadonlyArray<TaskRefEntry & { shortId: string }>;
  goals: ReadonlyArray<RefEntry & { shortId: string }>;
  memory: ReadonlyArray<RefEntry & { shortId: string }>;
}): RefMap {
  const strip = <T extends { shortId: string }>(entries: ReadonlyArray<T>): Map<string, Omit<T, "shortId">> => new Map(entries.map(({ shortId, ...entry }) => [shortId, entry]));
  return { tasks: strip(input.tasks), goals: strip(input.goals), memory: strip(input.memory) };
}

export function refKindOf(shortId: string): RefKind | null {
  if (shortId.startsWith("t")) return "tasks";
  if (shortId.startsWith("g")) return "goals";
  if (shortId.startsWith("m")) return "memory";
  return null;
}
