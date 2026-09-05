import { fileURLToPath } from "node:url";
import { z } from "zod";

const optionalSecret = z.preprocess((value) => (value === "" ? undefined : value), z.string().min(20).optional());
const pricingEntrySchema = z
  .object({
    inputUsdPerMillion: z.number().nonnegative().optional(),
    outputUsdPerMillion: z.number().nonnegative().optional(),
    cachedInputUsdPerMillion: z.number().nonnegative().optional(),
    audioUsdPerMinute: z.number().nonnegative().optional(),
    revision: z.string().min(1).max(64),
  })
  .superRefine((value, ctx) => {
    const hasInput = value.inputUsdPerMillion !== undefined;
    const hasOutput = value.outputUsdPerMillion !== undefined;
    if (hasInput !== hasOutput) {
      ctx.addIssue({ code: "custom", message: "text pricing requires both inputUsdPerMillion and outputUsdPerMillion" });
    }
    if (!hasInput && value.audioUsdPerMinute === undefined) {
      ctx.addIssue({ code: "custom", message: "pricing entry must contain text pricing or audioUsdPerMinute" });
    }
  });

const pricingSchema = z.record(z.string(), pricingEntrySchema);

const optionalPricing = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}, pricingSchema.optional());

const optionalSafeInteger = z.preprocess((value) => (value === "" || value === undefined ? undefined : value), z.coerce.number().int().positive().optional());

/** An operator flag. Absent, empty and `false` all mean off; only the two literals are accepted. */
const optionalFlag = z.preprocess(
  (value) => (value === "" || value === undefined ? "false" : value),
  z.enum(["true", "false"]).transform((value) => value === "true"),
);

const optionalUrl = z.preprocess((value) => (value === "" || value === undefined ? undefined : value), z.url().optional());

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1),
    /** Git commit the image was built from; injected by the Docker build, absent in local dev. */
    APP_COMMIT: z.string().trim().optional(),
    TELEGRAM_BOT_TOKEN: z.string().min(20),
    BOT_IDENTITY: z.string().min(1).max(64).default("ipsycho-main"),
    OWNER_TELEGRAM_USER_ID: optionalSafeInteger,
    HEALTHCHECK_PING_URL: z.preprocess((value) => (value === "" || value === undefined ? undefined : value), z.url().optional()),
    /**
     * The Telegram Mini App. Off by default and off in production until the app has been verified:
     * with the flag off neither the API nor the static files are mounted and the process behaves
     * exactly as it did before the app existed. There is no `WEBAPP_ONLY`; two flags meant four
     * states and two of them were nonsense.
     */
    WEBAPP_ENABLED: optionalFlag,
    /** Public origin the Mini App is served from; the `web_app` buttons are built from it. */
    WEBAPP_URL: optionalUrl,
    /** Where the built client lives. Defaults to `web/dist` next to the compiled server. */
    WEBAPP_DIST_PATH: z.preprocess((value) => (value === "" || value === undefined ? undefined : value), z.string().min(1).optional()),
    AI_PROVIDER: z.enum(["openai", "gemini", "deepseek"]).default("openai"),
    AI_MODEL: z.string().min(1),
    AI_TRANSCRIPTION_MODEL: z.string().min(1).default("gpt-4o-mini-transcribe"),
    AI_VOICE_MAX_DURATION_SECONDS: z.coerce.number().int().min(1).max(300).default(300),
    AI_VOICE_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(20 * 1024 * 1024)
      .default(20 * 1024 * 1024),
    AI_CONSENT_VERSION: z.string().min(1).max(32).default("2026-08-voice"),
    AI_PRICING_JSON: optionalPricing,
    /** Sent only when set: reasoning models accept only their default sampling and reject the field. */
    AI_TEMPERATURE: z.preprocess((value) => (value === "" || value === undefined ? undefined : value), z.coerce.number().min(0).max(2).optional()),
    /** Upper bound on generated tokens per request, reasoning included; the reply itself is capped at 4000 characters. */
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_000).default(4_000),
    AI_MAX_MESSAGES_PER_HOUR: z.coerce.number().int().min(5).max(1000).default(60),
    AI_MAX_CALLS_PER_HOUR: z.coerce.number().int().min(5).max(1000).default(60),
    /** Default monthly AI spend (USD) at which a user and the owner are warned; per-user settings override it. */
    AI_MONTHLY_WARNING_USD: z.preprocess((value) => (value === "" || value === undefined ? undefined : value), z.coerce.number().positive().optional()),
    OPENAI_API_KEY: optionalSecret,
    GEMINI_API_KEY: optionalSecret,
    DEEPSEEK_API_KEY: optionalSecret,
  })
  .superRefine((value, ctx) => {
    if (value.WEBAPP_ENABLED && !value.WEBAPP_URL) {
      ctx.addIssue({ code: "custom", path: ["WEBAPP_URL"], message: "WEBAPP_ENABLED=true requires WEBAPP_URL" });
    }
    // Telegram opens a Mini App over HTTPS only; http is allowed for a loopback development host,
    // where there is no certificate and no third party on the path.
    if (value.WEBAPP_URL && !isAllowedWebAppOrigin(value.WEBAPP_URL)) {
      ctx.addIssue({ code: "custom", path: ["WEBAPP_URL"], message: "WEBAPP_URL must be https, or http on localhost" });
    }
    const key = value.AI_PROVIDER === "openai" ? value.OPENAI_API_KEY : value.AI_PROVIDER === "gemini" ? value.GEMINI_API_KEY : value.DEEPSEEK_API_KEY;
    if (!key) {
      const name = value.AI_PROVIDER === "openai" ? "OPENAI_API_KEY" : value.AI_PROVIDER === "gemini" ? "GEMINI_API_KEY" : "DEEPSEEK_API_KEY";
      ctx.addIssue({ code: "custom", path: [name], message: `AI_PROVIDER=${value.AI_PROVIDER} requires ${name}` });
    }
  });

export type AiProviderName = "openai" | "gemini" | "deepseek";
export interface AiModelPricing {
  inputUsdPerMillion?: number | undefined;
  outputUsdPerMillion?: number | undefined;
  cachedInputUsdPerMillion?: number | undefined;
  audioUsdPerMinute?: number | undefined;
  revision: string;
}

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  appCommit?: string;
  host: string;
  port: number;
  databaseUrl: string;
  telegramBotToken: string;
  botIdentity: string;
  ownerTelegramUserId?: number;
  /** Dead-man switch: pinged after every successful maintenance tick; the service alerts when pings stop. */
  healthcheckPingUrl?: string;
  /** Mounts the Mini App API and its static files. Off means neither exists. */
  webAppEnabled: boolean;
  /** Set whenever `webAppEnabled` is true; the schema refuses the combination without it. */
  webAppUrl?: string;
  /** Absolute path of the built client that is served under `/app`. */
  webAppDistPath: string;
  aiProvider: AiProviderName;
  aiModel: string;
  aiTranscriptionModel: string;
  aiVoiceMaxDurationSeconds: number;
  aiVoiceMaxBytes: number;
  aiConsentVersion: string;
  aiPricing: Record<string, AiModelPricing>;
  aiTemperature?: number;
  aiMaxOutputTokens: number;
  aiMaxMessagesPerHour: number;
  aiMaxCallsPerHour: number;
  aiMonthlyWarningUsd?: number;
  openAiApiKey?: string;
  geminiApiKey?: string;
  deepSeekApiKey?: string;
}

/**
 * `web/dist` next to the compiled server: `dist/main.js` → `<root>/web/dist`. The image may put it
 * elsewhere, which is what `WEBAPP_DIST_PATH` is for — so group 9 can move it without touching
 * `main.ts`.
 */
const DEFAULT_WEBAPP_DIST_PATH = fileURLToPath(new URL("../web/dist", import.meta.url));

/**
 * Telegram will only open a Mini App over HTTPS. `http://localhost` is allowed because a developer
 * running `npm run dev:web` has no certificate and no third party on the path.
 */
function isAllowedWebAppOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

/**
 * The flag on its own, without validating the rest of the environment.
 *
 * `AppModule`'s `imports` array is evaluated before any provider exists, so `ApiModule.register`
 * cannot ask `APP_CONFIG` whether the Mini App is on. It asks this instead — the same variable,
 * parsed by the same schema fragment, so the two answers cannot drift.
 */
export function isWebAppEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return optionalFlag.parse(env.WEBAPP_ENABLED) === true;
}

export const APP_CONFIG = Symbol("APP_CONFIG");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const value = schema.parse(env);
  return {
    nodeEnv: value.NODE_ENV,
    ...(value.APP_COMMIT && value.APP_COMMIT !== "unknown" ? { appCommit: value.APP_COMMIT } : {}),
    host: value.HOST,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    telegramBotToken: value.TELEGRAM_BOT_TOKEN,
    botIdentity: value.BOT_IDENTITY,
    ...(value.OWNER_TELEGRAM_USER_ID ? { ownerTelegramUserId: value.OWNER_TELEGRAM_USER_ID } : {}),
    ...(value.HEALTHCHECK_PING_URL ? { healthcheckPingUrl: value.HEALTHCHECK_PING_URL } : {}),
    webAppEnabled: value.WEBAPP_ENABLED,
    ...(value.WEBAPP_URL ? { webAppUrl: value.WEBAPP_URL } : {}),
    webAppDistPath: value.WEBAPP_DIST_PATH ?? DEFAULT_WEBAPP_DIST_PATH,
    aiProvider: value.AI_PROVIDER,
    aiModel: value.AI_MODEL,
    aiTranscriptionModel: value.AI_TRANSCRIPTION_MODEL,
    aiVoiceMaxDurationSeconds: value.AI_VOICE_MAX_DURATION_SECONDS,
    aiVoiceMaxBytes: value.AI_VOICE_MAX_BYTES,
    aiConsentVersion: value.AI_CONSENT_VERSION,
    aiPricing: value.AI_PRICING_JSON ?? {},
    ...(value.AI_TEMPERATURE !== undefined ? { aiTemperature: value.AI_TEMPERATURE } : {}),
    aiMaxOutputTokens: value.AI_MAX_OUTPUT_TOKENS,
    aiMaxMessagesPerHour: value.AI_MAX_MESSAGES_PER_HOUR,
    aiMaxCallsPerHour: value.AI_MAX_CALLS_PER_HOUR,
    ...(value.AI_MONTHLY_WARNING_USD ? { aiMonthlyWarningUsd: value.AI_MONTHLY_WARNING_USD } : {}),
    ...(value.OPENAI_API_KEY ? { openAiApiKey: value.OPENAI_API_KEY } : {}),
    ...(value.GEMINI_API_KEY ? { geminiApiKey: value.GEMINI_API_KEY } : {}),
    ...(value.DEEPSEEK_API_KEY ? { deepSeekApiKey: value.DEEPSEEK_API_KEY } : {}),
  };
}

/** Configuration that is valid but leaves a feature silently off; reported once at startup. */
export function configWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  const textPricing = config.aiPricing[config.aiModel];
  if (!textPricing?.inputUsdPerMillion) warnings.push(`AI_PRICING_JSON has no text pricing for AI_MODEL=${config.aiModel}; spend estimates and warnings stay empty`);
  if (config.aiProvider === "openai" && !config.aiPricing[config.aiTranscriptionModel]?.audioUsdPerMinute)
    warnings.push(`AI_PRICING_JSON has no audio pricing for ${config.aiTranscriptionModel}; voice spend is not estimated`);
  if (config.aiProvider !== "openai") warnings.push(`AI_PROVIDER=${config.aiProvider}: voice transcription is unavailable, only OpenAI transcribes`);
  return warnings;
}
