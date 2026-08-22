import test from "node:test";
import assert from "node:assert/strict";
import { redactContextForExternalAi, redactMessagesForExternalAi } from "../../dist/ai/ai.service.js";
import { redactSensitiveText, safeMessageMetadata } from "../../dist/observability/safe-error.js";

test("credentials are removed before messages are sent to an external AI provider", () => {
  const result = redactMessagesForExternalAi([
    { role: "user", content: "пароль=password=correct-horse-battery-staple, key sk-proj_abcdefghijklmnopqrstuvwxyz" },
    { role: "assistant", content: "ok" },
  ]);
  assert.doesNotMatch(result[0].content, /correct-horse|sk-proj_/);
  assert.match(result[0].content, /\[redacted\]/);
  assert.equal(result[1].content, "ok");
});

test("credentials in task context cannot reach the system prompt", () => {
  const context = redactContextForExternalAi({ task: { title: "VPN", context: "token=super-secret-value" } });
  assert.doesNotMatch(JSON.stringify(context), /super-secret-value/);
});

test("logs retain a stable diagnostic fingerprint but not message contents", () => {
  const source = "telegram token 123456:abcdefghijklmnopqrstuvwxyzABCDE";
  assert.doesNotMatch(redactSensitiveText(source), /abcdefghijklmnopqrstuvwxyz/);
  const metadata = safeMessageMetadata(source);
  assert.equal(metadata.length, source.length);
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(metadata), /telegram token|abcdefghijklmnopqrstuvwxyz/);
});
