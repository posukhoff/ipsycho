import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
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
