import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptionService } from "../../dist/ai/transcription.service.js";

const config = {
  aiProvider: "openai",
  openAiApiKey: "sk-test",
  aiConsentVersion: "v2",
  aiTranscriptionModel: "whisper-test",
  aiVoiceMaxDurationSeconds: 120,
  aiVoiceMaxBytes: 2_000_000,
  aiPricing: {},
};

function repository(hasConsent) {
  const usage = [];
  return { usage, hasConsent: async () => hasConsent, recordUsage: async (row) => void usage.push(row) };
}

test("voice is refused at the provider boundary when consent for this version is missing, and nothing is sent", async () => {
  const repo = repository(false);
  const service = new TranscriptionService(config, repo);
  const client = { audio: { transcriptions: { create: async () => assert.fail("audio must not leave the process without consent") } } };
  service.client = client;
  await assert.rejects(() => service.transcribe({ workspaceId: "ws", userId: "u", audio: Buffer.from("x"), durationSeconds: 3 }), /consent is missing/);
  assert.deepEqual(repo.usage, []);
});

test("a failed transcription is still recorded as usage and the error propagates", async () => {
  const repo = repository(true);
  const service = new TranscriptionService(config, repo);
  service.client = {
    audio: {
      transcriptions: {
        create: async () => {
          throw new Error("provider is down");
        },
      },
    },
  };
  await assert.rejects(() => service.transcribe({ workspaceId: "ws", userId: "u", audio: Buffer.from("x"), durationSeconds: 3 }), /provider is down/);
  assert.equal(repo.usage.length, 1);
  assert.equal(repo.usage[0].status, "transcription_error");
});

test("voice limits are enforced before any download", () => {
  const service = new TranscriptionService(config, repository(true));
  assert.equal(service.acceptsVoice(60, 500_000), true);
  assert.equal(service.acceptsVoice(300, 500_000), false);
  assert.equal(service.acceptsVoice(60, 5_000_000), false);
});

test("transcription is unavailable when the active provider is not OpenAI", () => {
  const service = new TranscriptionService({ ...config, aiProvider: "gemini" }, repository(true));
  assert.equal(service.isAvailable(), false);
});
