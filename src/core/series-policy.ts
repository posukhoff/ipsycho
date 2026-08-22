export type SeriesOperation = "pause" | "resume" | "stop" | "cancel";

export interface SeriesProjectionState {
  parentStatus: "active" | "paused" | "closed" | "cancelled";
  currentOccurrenceAction: "keep" | "cancel";
  deleteUntouchedFuture: boolean;
  rematerializeFuture: boolean;
}

export function seriesOperationState(operation: SeriesOperation, hasCurrentNonterminal: boolean): SeriesProjectionState {
  if (operation === "pause") {
    return { parentStatus: "paused", currentOccurrenceAction: "keep", deleteUntouchedFuture: true, rematerializeFuture: false };
  }
  if (operation === "resume") {
    return { parentStatus: "active", currentOccurrenceAction: "keep", deleteUntouchedFuture: false, rematerializeFuture: true };
  }
  if (operation === "cancel") {
    return { parentStatus: "cancelled", currentOccurrenceAction: hasCurrentNonterminal ? "cancel" : "keep", deleteUntouchedFuture: true, rematerializeFuture: false };
  }
  return {
    parentStatus: hasCurrentNonterminal ? "active" : "closed",
    currentOccurrenceAction: "keep",
    deleteUntouchedFuture: true,
    rematerializeFuture: false,
  };
}
