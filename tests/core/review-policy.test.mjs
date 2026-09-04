import test from "node:test";
import assert from "node:assert/strict";
import { reviewClarificationDecision, reviewCorrection, reviewPresentation } from "../../.core-dist/review-policy.js";

test("evening review keeps the third question open instead of resolving before the answer", () => {
  const decision = reviewClarificationDecision({ kind: "evening", clarificationCountBeforeTurn: 2, askedQuestion: true });
  assert.deepEqual(decision, { checkpoint: true, forceConclusion: false, resolveAfterTurn: false });
});

test("evening review forces a conclusion on the turn after three questions", () => {
  const decision = reviewClarificationDecision({ kind: "evening", clarificationCountBeforeTurn: 3, askedQuestion: true });
  assert.deepEqual(decision, { checkpoint: false, forceConclusion: true, resolveAfterTurn: true });
  assert.match(reviewCorrection("evening", true), /question=null/);
});

test("evening review resolves naturally when no clarification question is needed", () => {
  assert.deepEqual(
    reviewClarificationDecision({ kind: "evening", clarificationCountBeforeTurn: 1, askedQuestion: false }),
    { checkpoint: false, forceConclusion: false, resolveAfterTurn: true },
  );
});

test("weekly review stays open for collaborative planning instead of making automatic changes", () => {
  assert.deepEqual(
    reviewClarificationDecision({ kind: "weekly", clarificationCountBeforeTurn: 0, askedQuestion: true }),
    { checkpoint: false, forceConclusion: false, resolveAfterTurn: false },
  );
  assert.match(reviewCorrection("weekly"), /Do not create, reschedule/);
  assert.match(reviewCorrection("weekly"), /intent=inferred/);
  assert.match(reviewCorrection("weekly"), /intent=explicit only for a change the user explicitly chose/);
  assert.match(reviewCorrection("weekly"), /question field, never hidden in reply/);
});

test("weekly planning allows one focused question for each of five required dimensions", () => {
  assert.deepEqual(
    reviewClarificationDecision({ kind: "weekly", clarificationCountBeforeTurn: 4, askedQuestion: true }),
    { checkpoint: true, forceConclusion: false, resolveAfterTurn: false },
  );
  assert.deepEqual(
    reviewClarificationDecision({ kind: "weekly", clarificationCountBeforeTurn: 5, askedQuestion: true }),
    { checkpoint: false, forceConclusion: true, resolveAfterTurn: true },
  );
  assert.deepEqual(
    reviewPresentation({ kind: "weekly", clarificationCountBeforeTurn: 1, askedQuestion: true }),
    { kind: "weekly", step: 2, totalSteps: 5, completed: false },
  );
});

test("evening review allows an initial clarification without checkpoint", () => {
  assert.deepEqual(
    reviewClarificationDecision({ kind: "evening", clarificationCountBeforeTurn: 0, askedQuestion: true }),
    { checkpoint: false, forceConclusion: false, resolveAfterTurn: false },
  );
});

test("evening review with three prior questions concludes even when the model returns no question", () => {
  assert.deepEqual(
    reviewClarificationDecision({ kind: "evening", clarificationCountBeforeTurn: 3, askedQuestion: false }),
    { checkpoint: false, forceConclusion: true, resolveAfterTurn: true },
  );
});


test("evening review presentation exposes compact 1/3 progress", () => {
  assert.deepEqual(
    reviewPresentation({ kind: "evening", clarificationCountBeforeTurn: 0, askedQuestion: true }),
    { kind: "evening", step: 1, totalSteps: 3, completed: false },
  );
  assert.deepEqual(
    reviewPresentation({ kind: "evening", clarificationCountBeforeTurn: 2, askedQuestion: true }),
    { kind: "evening", step: 3, totalSteps: 3, completed: false },
  );
});

test("review presentation marks conclusion as completed", () => {
  assert.deepEqual(
    reviewPresentation({ kind: "evening", clarificationCountBeforeTurn: 3, askedQuestion: false }),
    { kind: "evening", completed: true },
  );
  assert.deepEqual(reviewPresentation({ kind: "weekly", clarificationCountBeforeTurn: 0, askedQuestion: false }), { kind: "weekly", completed: true });
});
