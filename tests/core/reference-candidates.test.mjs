import test from "node:test";
import assert from "node:assert/strict";
import { withTaskCandidates } from "../../.core-dist/reference-candidates.js";

const refs = {
  tasks: new Map([
    ["t1", { id: "a", version: 1, title: "Созвон с дизайнером", timeMode: "point", recurring: false, status: "active" }],
    ["t2", { id: "b", version: 1, title: "Созвон с Антоном", timeMode: "point", recurring: false, status: "active" }],
    ["t3", { id: "c", version: 1, title: "Купить молоко", timeMode: "date", recurring: false, status: "active" }],
  ]),
  goals: new Map(),
  memory: new Map(),
};
const notFound = { kind: "reference", index: 0, code: "ref_not_found", message: "task t9 is not in the current context" };

test("an unknown task id becomes a choice among the tasks the message could mean", () => {
  const [issue] = withTaskCandidates([notFound], refs, "перенеси созвон на пятницу");
  assert.equal(issue.kind, "ambiguous");
  assert.equal(issue.code, "task_candidates");
  assert.deepEqual(issue.candidates.map((c) => c.title), ["Созвон с дизайнером", "Созвон с Антоном"]);
});

test("without a matching title the issue is left as it was", () => {
  assert.deepEqual(withTaskCandidates([notFound], refs, "перенеси встречу"), [notFound]);
  assert.deepEqual(withTaskCandidates([notFound], refs, "да"), [notFound]);
  const goal = { ...notFound, message: "goal g9 is not in the current context" };
  assert.deepEqual(withTaskCandidates([goal], refs, "созвон"), [goal]);
});
