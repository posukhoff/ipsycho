/**
 * The fake user for persona cases: a model that texts the bot for a few turns, given a goal and a
 * character. It is deliberately *not* a judge — it never decides whether a case passed. The verdict
 * stays with the declarative checks in eval-agent.mjs, because a run where the same model invents
 * the scenario and grades it goes red on its own noise and stops being read.
 *
 * It talks to the provider on its own client, so its tokens never reach `ai_usage`: the
 * `maxProviderCalls` budget must keep counting only what the product itself spent.
 */
import { createOpenAiCompatibleClient } from "../dist/ai/ai-client.js";
import { DEEPSEEK_BASE_URL } from "../dist/ai/deepseek.provider.js";
import { GEMINI_OPENAI_BASE_URL } from "../dist/ai/gemini.provider.js";

const TRANSIENT = /\b(429|500|502|503|504)\b|ECONNRESET|ETIMEDOUT/u;
const LANGUAGE_NAMES = { ru: "Russian", uk: "Ukrainian", en: "English" };
export const DEFAULT_MAX_TURNS = 6;

/**
 * The persona speaks with a temperature so two runs are not carbon copies — a user who phrases the
 * same thing one way every time tests one phrasing. Determinism lives in the expectations, not here.
 */
const TEMPERATURE = 0.6;

export function createPersona(config, options = {}) {
  const model = options.model ?? process.env.EVAL_PERSONA_MODEL ?? config.aiModel;
  const credentials = resolveCredentials(config);
  const client = credentials ? createOpenAiCompatibleClient(credentials) : null;
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

  return {
    model,
    usage,
    isConfigured: () => client !== null,
    /**
     * The next thing the fake user sends. `transcript` is the conversation so far, oldest first,
     * as the user saw it on screen — the bot's rendered message, card and buttons included.
     */
    async next({ persona, language, transcript }) {
      if (!client) throw new Error("persona: no API key for the configured provider");
      const messages = [
        { role: "system", content: systemPrompt(persona, language) },
        ...transcript.map((line) => ({ role: line.from === "user" ? "assistant" : "user", content: line.text })),
      ];
      const raw = await complete(client, model, messages, usage);
      return parseStep(raw);
    },
  };
}

function resolveCredentials(config) {
  const apiKey = process.env.EVAL_PERSONA_API_KEY;
  const baseURL = process.env.EVAL_PERSONA_BASE_URL;
  if (apiKey) return { apiKey, ...(baseURL ? { baseURL } : {}) };
  if (config.aiProvider === "openai") return config.openAiApiKey ? { apiKey: config.openAiApiKey } : null;
  if (config.aiProvider === "gemini") return config.geminiApiKey ? { apiKey: config.geminiApiKey, baseURL: GEMINI_OPENAI_BASE_URL } : null;
  return config.deepSeekApiKey ? { apiKey: config.deepSeekApiKey, baseURL: DEEPSEEK_BASE_URL } : null;
}

function systemPrompt(persona, language) {
  return [
    "You are a real person texting a personal-assistant bot in a messenger. You are the user, never the assistant.",
    "",
    `What you want out of this conversation: ${persona.goal}`,
    `How you write: ${persona.traits ?? "plainly, the way a busy person texts"}`,
    `Write every message in ${LANGUAGE_NAMES[language] ?? "Russian"}.`,
    "",
    "Rules:",
    "- One short message per turn, the way a person texts. No lists, no markdown, no stage directions.",
    "- Never mention that you are testing, evaluating or playing a role.",
    "- Pursue only what you want, above. Never invent extra tasks, dates or details it does not mention.",
    "- Answer whatever the bot asks you. If your character starts vague, stay vague until the bot asks, then give the missing detail.",
    "- A line in square brackets at the end of a reply lists the buttons on that message. Sending a button's label exactly presses it; anything else is a normal message.",
    "- When the bot proposes changes and waits for a confirmation, press the confirm button if the proposal is what you wanted, or say in your own words what is wrong if it is not.",
    "- Never press a button whose effect you do not want. Undo puts a change back; press it only if you want the change gone.",
    "- Set done to true when you have nothing left to send: the bot has already done what you wanted, or it has failed the same thing twice and a real person would give up. Leave message empty then — do not send a bare thanks or an ok.",
    "",
    "Answer with one JSON object and nothing else:",
    '{"message": "<what you send next, may be empty only when done>", "done": <true|false>, "why": "<at most 12 words>"}',
  ].join("\n");
}

async function complete(client, model, messages, usage) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      usage.calls += 1;
      const response = await client.chat.completions.create({
        model,
        messages,
        temperature: TEMPERATURE,
        response_format: { type: "json_object" },
      });
      usage.inputTokens += response.usage?.prompt_tokens ?? 0;
      usage.outputTokens += response.usage?.completion_tokens ?? 0;
      const text = response.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (error) {
      const message = String(error);
      // A model that rejects the sampling knobs is a configuration problem, not a flaky network:
      // saying so beats one more identical request.
      if (/temperature|response_format/iu.test(message)) throw new Error(`persona: model ${model} rejected the request shape`, { cause: error });
      if (attempt || !TRANSIENT.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  throw new Error("persona: the model returned nothing twice");
}

function parseStep(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The persona is scenery, not the assertion: a mangled turn ends the conversation and the
    // expectations are still checked against whatever state the bot reached.
    return { message: "", done: true, why: "persona returned invalid json" };
  }
  return {
    message: typeof parsed.message === "string" ? parsed.message.trim() : "",
    done: parsed.done === true,
    why: typeof parsed.why === "string" ? parsed.why.slice(0, 120) : "",
  };
}
