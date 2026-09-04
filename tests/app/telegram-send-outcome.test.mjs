import test from "node:test";
import assert from "node:assert/strict";
import { GrammyError, HttpError } from "grammy";
import { classifyTelegramSendError } from "../../dist/telegram/telegram-send-outcome.js";

const api = (error_code, description, parameters = {}) => new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code, description, parameters }, "sendMessage", {});

test("429 carries Telegram's retry_after and never spends an attempt", () => {
  assert.deepEqual(classifyTelegramSendError(api(429, "Too Many Requests", { retry_after: 7 })), { kind: "rate_limited", retryAfterSeconds: 7 });
  assert.deepEqual(classifyTelegramSendError(api(429, "Too Many Requests")), { kind: "rate_limited", retryAfterSeconds: 5 });
});

test("client errors are permanent rejections, server errors are transient", () => {
  assert.deepEqual(classifyTelegramSendError(api(403, "Forbidden: bot was blocked by the user")), { kind: "rejected", errorCode: 403 });
  assert.deepEqual(classifyTelegramSendError(api(400, "Bad Request: chat not found")), { kind: "rejected", errorCode: 400 });
  assert.deepEqual(classifyTelegramSendError(api(502, "Bad Gateway")), { kind: "transient" });
});

test("a connection that never opened is transient; a timeout mid-request is ambiguous", () => {
  const refused = new TypeError("fetch failed");
  refused.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.deepEqual(classifyTelegramSendError(new HttpError("Network request for 'sendMessage' failed!", refused)), { kind: "transient" });

  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  assert.deepEqual(classifyTelegramSendError(new HttpError("Network request for 'sendMessage' failed!", abort)), { kind: "ambiguous" });
  assert.deepEqual(classifyTelegramSendError(new HttpError("Network request for 'sendMessage' failed!", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))), {
    kind: "ambiguous",
  });
});

test("anything else is unknown and left to the bounded retry policy", () => {
  assert.deepEqual(classifyTelegramSendError(new Error("boom")), { kind: "unknown" });
});
