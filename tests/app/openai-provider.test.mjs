import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { AiTurnSchema, AiTurnWireSchema } from "../../dist/ai/ai-contracts.js";
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
  const format = zodTextFormat(AiTurnWireSchema, "ipsycho_turn");
  assert.equal(format.type, "json_schema");
  assert.equal(format.name, "ipsycho_turn");
  assert.equal(format.strict, true);
});

test("the repair suffix carries Zod issue paths and codes but never values", () => {
  const result = AiTurnSchema.safeParse({
    reply: "ok",
    question: null,
    topic: { mode: "none", title: null, summary: null },
    actions: [{ type: "memory", intent: "explicit", op: "save", item: null, kind: "note", content: "secret-token-value", sensitive: "yes" }],
  });
  assert.equal(result.success, false);
  const issues = describeStructuredIssues(result.error);
  assert.ok(
    issues.some((issue) => issue.startsWith("actions.0.sensitive: ")),
    issues.join("; "),
  );
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
  assert.deepEqual(
    Object.keys(error).filter((key) => key !== "name"),
    [],
  );
  assert.equal("payload" in error, false);
});

test("every provider client carries a bounded request timeout instead of the SDK's ten minutes", async () => {
  const { AI_REQUEST_TIMEOUT_MS, createOpenAiCompatibleClient } = await import("../../dist/ai/ai-client.js");
  const client = createOpenAiCompatibleClient({ apiKey: "sk-test-key-with-enough-length" });
  assert.equal(client.timeout, AI_REQUEST_TIMEOUT_MS);
  assert.equal(client.maxRetries, 0);
  assert.ok(AI_REQUEST_TIMEOUT_MS <= 60_000);
});

test("a repaired call counts both requests and their cached tokens, and never stores content", async () => {
  const { OpenAiProvider } = await import("../../dist/ai/openai.provider.js");
  const requests = [];
  // The wire shape the model fills: one array per action kind, flattened by the provider.
  const validTurn = JSON.stringify({
    reply: "Записал.",
    question: null,
    createTasks: [],
    updateTasks: [],
    setTaskStates: [],
    reschedules: [],
    setReminders: [],
    goalOps: [],
    plans: [],
    memories: [],
    settingsChanges: [],
    topic: { mode: "none", title: null, summary: null },
  });
  const responses = [
    { id: "resp-1", output: [], output_text: "{ not json", usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 60 } } },
    { id: "resp-2", output: [], output_text: validTurn, usage: { input_tokens: 110, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } } },
  ];
  const provider = Object.create(OpenAiProvider.prototype);
  provider.client = {
    responses: {
      create: async (request) => {
        requests.push(request);
        return responses.shift();
      },
    },
  };

  const result = await provider.generate({ model: "m", systemPrompt: "system", messages: [{ role: "user", content: "привет" }], maxOutputTokens: 4000 });
  assert.equal(result.attempts, 2);
  assert.equal(result.inputTokens, 210);
  assert.equal(result.outputTokens, 25);
  assert.equal(result.cachedInputTokens, 120);
  assert.equal(result.requestId, "resp-2");
  assert.equal(result.turn.reply, "Записал.");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].max_output_tokens, 4000);
  assert.equal("temperature" in requests[0], false, "temperature is sent only when configured");
  assert.match(requests[1].input[0].content, /Previous structured output was invalid/);
});

test("a refusal is repaired once and then surfaces as unusable output", async () => {
  const { OpenAiProvider } = await import("../../dist/ai/openai.provider.js");
  const refusal = { id: "r", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], output_text: "", usage: { input_tokens: 1, output_tokens: 1 } };
  const provider = Object.create(OpenAiProvider.prototype);
  let calls = 0;
  provider.client = {
    responses: {
      create: async () => {
        calls += 1;
        return refusal;
      },
    },
  };
  await assert.rejects(() => provider.generate({ model: "m", systemPrompt: "s", messages: [] }), AiStructuredOutputError);
  assert.equal(calls, 2);
});
