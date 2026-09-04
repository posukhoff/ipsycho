import test from "node:test";
import assert from "node:assert/strict";
import { configWarnings, loadConfig } from "../../dist/config.js";

const base = {
  DATABASE_URL: "postgres://x:y@localhost:5432/db",
  TELEGRAM_BOT_TOKEN: "123456:telegram-token-with-enough-length",
  AI_PROVIDER: "openai",
  AI_MODEL: "gpt-test",
  OPENAI_API_KEY: "sk-openai-key-with-enough-length",
};

test("the active provider must have its own key; another provider's key does not count", () => {
  assert.equal(loadConfig(base).aiProvider, "openai");
  assert.throws(() => loadConfig({ ...base, AI_PROVIDER: "gemini" }), /GEMINI_API_KEY/);
  assert.equal(loadConfig({ ...base, AI_PROVIDER: "gemini", GEMINI_API_KEY: "gemini-key-with-enough-length-1" }).aiProvider, "gemini");
});

test("the Telegram token is required at configuration time, not at bot construction", () => {
  assert.throws(() => loadConfig({ ...base, TELEGRAM_BOT_TOKEN: "" }), /TELEGRAM_BOT_TOKEN/);
});

test("a default monthly spend warning is optional and positive", () => {
  assert.equal(loadConfig(base).aiMonthlyWarningUsd, undefined);
  assert.equal(loadConfig({ ...base, AI_MONTHLY_WARNING_USD: "12.5" }).aiMonthlyWarningUsd, 12.5);
  assert.throws(() => loadConfig({ ...base, AI_MONTHLY_WARNING_USD: "-1" }));
});

test("silently disabled features are reported as warnings", () => {
  const warnings = configWarnings(loadConfig(base));
  assert.ok(
    warnings.some((w) => /no text pricing for AI_MODEL=gpt-test/.test(w)),
    warnings.join("\n"),
  );
  const priced = loadConfig({
    ...base,
    AI_PRICING_JSON: JSON.stringify({
      "gpt-test": { inputUsdPerMillion: 1, outputUsdPerMillion: 2, revision: "r1" },
      "gpt-4o-mini-transcribe": { audioUsdPerMinute: 0.01, revision: "r1" },
    }),
  });
  assert.deepEqual(configWarnings(priced), []);
  const deepseek = loadConfig({ ...base, AI_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "deepseek-key-with-enough-length" });
  assert.ok(configWarnings(deepseek).some((w) => /voice transcription is unavailable/.test(w)));
});
