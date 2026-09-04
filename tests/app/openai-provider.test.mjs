import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { AiTurnSchema } from "../../dist/ai/ai-contracts.js";
import { AiStructuredOutputError, describeStructuredIssues, structuredRepairSuffix } from "../../dist/ai/ai-provider.js";
import { isStructuredOutputValidationError } from "../../dist/ai/openai.provider.js";

test("OpenAI structured-output schema errors are eligible for one repair attempt", () => {
  let schemaError;
  try {
    z.object({ stepId: z.string() }).parse({ stepId: 42 });
  } catch (error) {
    schemaError = error;
  }
  assert.equal(isStructuredOutputValidationError(schemaError), true);
  assert.equal(isStructuredOutputValidationError(new Error("network failure")), false);
});

test("the model contract is expressible as an OpenAI strict text format", () => {
  // zodTextFormat rejects optional keys and defaults: every field must be required (nullable).
  const format = zodTextFormat(AiTurnSchema, "ipsycho_turn");
  assert.equal(format.type, "json_schema");
  assert.equal(format.name, "ipsycho_turn");
  assert.equal(format.strict, true);
});

test("the repair suffix carries Zod issue paths and codes but never values", () => {
  const result = AiTurnSchema.safeParse({
    reply: "ok", question: null, topic: { mode: "none", title: null, summary: null },
    actions: [{ type: "memory", intent: "explicit", op: "save", item: null, kind: "note", content: "secret-token-value", sensitive: "yes" }],
  });
  assert.equal(result.success, false);
  const issues = describeStructuredIssues(result.error);
  assert.ok(issues.some((issue) => issue.startsWith("actions.0.sensitive: ")), issues.join("; "));
  const suffix = structuredRepairSuffix(issues);
  assert.match(suffix, /Schema issues \(path: code\)/);
  assert.doesNotMatch(suffix, /secret-token-value/);
  assert.equal(structuredRepairSuffix([]).includes("Schema issues"), false);
  assert.deepEqual(describeStructuredIssues(undefined), []);
});

test("AiStructuredOutputError is a plain Error subclass without a payload", () => {
  const error = new AiStructuredOutputError("no valid structured output");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "AiStructuredOutputError");
  assert.deepEqual(Object.keys(error).filter((key) => key !== "name"), []);
  assert.equal("payload" in error, false);
});

test("every provider client carries a bounded request timeout instead of the SDK's ten minutes", async () => {
  const { AI_REQUEST_TIMEOUT_MS, createOpenAiCompatibleClient } = await import("../../dist/ai/ai-client.js");
  const client = createOpenAiCompatibleClient({ apiKey: "sk-test-key-with-enough-length" });
  assert.equal(client.timeout, AI_REQUEST_TIMEOUT_MS);
  assert.equal(client.maxRetries, 0);
  assert.ok(AI_REQUEST_TIMEOUT_MS <= 60_000);
});
