import { z } from "zod";

const optionalSecret = z.preprocess((value) => value === "" ? undefined : value, z.string().min(20).optional());
const pricingEntrySchema = z.object({
  inputUsdPerMillion: z.number().nonnegative().optional(),
  outputUsdPerMillion: z.number().nonnegative().optional(),
  audioUsdPerMinute: z.number().nonnegative().optional(),
  revision: z.string().min(1).max(64),
}).superRefine((value, ctx) => {
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
  try { return JSON.parse(value); } catch { return value; }
}, pricingSchema.optional());

const optionalSafeInteger = z.preprocess((value) => value === "" || value === undefined ? undefined : value, z.coerce.number().int().positive().optional());
const booleanFlag = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true" ? true : value.toLowerCase() === "false" ? false : value;
  return value;
}, z.boolean().optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  /** Git commit the image was built from; injected by the Docker build, absent in local dev. */
  APP_COMMIT: z.string().trim().optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  BOT_IDENTITY: z.string().min(1).max(64).default("ipsycho-main"),
  OWNER_TELEGRAM_USER_ID: optionalSafeInteger,
  AI_PROVIDER: z.enum(["openai", "gemini", "deepseek"]).default("openai"),
  AI_MODEL: z.string().min(1),
  AI_MODEL_DEEP: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
  AI_TRANSCRIPTION_MODEL: z.string().min(1).default("gpt-4o-mini-transcribe"),
  AI_VOICE_MAX_DURATION_SECONDS: z.coerce.number().int().min(1).max(300).default(300),
  AI_VOICE_MAX_BYTES: z.coerce.number().int().min(1).max(20 * 1024 * 1024).default(20 * 1024 * 1024),
  AI_CONSENT_VERSION: z.string().min(1).max(32).default("2026-08-voice"),
  AI_PRICING_JSON: optionalPricing,
  AI_MAX_MESSAGES_PER_HOUR: z.coerce.number().int().min(5).max(1000).default(60),
  AI_MAX_CALLS_PER_HOUR: z.coerce.number().int().min(5).max(1000).default(60),
  /** Default monthly AI spend (USD) at which a user and the owner are warned; per-user settings override it. */
  AI_MONTHLY_WARNING_USD: z.preprocess((value) => value === "" || value === undefined ? undefined : value, z.coerce.number().positive().optional()),
  OPENAI_API_KEY: optionalSecret,
  GEMINI_API_KEY: optionalSecret,
  DEEPSEEK_API_KEY: optionalSecret,
}).superRefine((value, ctx) => {
  const key = value.AI_PROVIDER === "openai" ? value.OPENAI_API_KEY : value.AI_PROVIDER === "gemini" ? value.GEMINI_API_KEY : value.DEEPSEEK_API_KEY;
  if (!key) {
    const name = value.AI_PROVIDER === "openai" ? "OPENAI_API_KEY" : value.AI_PROVIDER === "gemini" ? "GEMINI_API_KEY" : "DEEPSEEK_API_KEY";
    ctx.addIssue({ code: "custom", path: [name], message: `AI_PROVIDER=${value.AI_PROVIDER} requires ${name}` });
  }
});

export type AiProviderName = "openai" | "gemini" | "deepseek";
export interface AiModelPricing { inputUsdPerMillion?: number | undefined; outputUsdPerMillion?: number | undefined; audioUsdPerMinute?: number | undefined; revision: string }

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  appCommit?: string;
  host: string;
  port: number;
  databaseUrl: string;
  telegramBotToken: string;
  botIdentity: string;
  ownerTelegramUserId?: number;
  aiProvider: AiProviderName;
  aiModel: string;
  aiDeepModel?: string;
  aiTranscriptionModel: string;
  aiVoiceMaxDurationSeconds: number;
  aiVoiceMaxBytes: number;
  aiConsentVersion: string;
  aiPricing: Record<string, AiModelPricing>;
  aiMaxMessagesPerHour: number;
  aiMaxCallsPerHour: number;
  aiMonthlyWarningUsd?: number;
  openAiApiKey?: string;
  geminiApiKey?: string;
  deepSeekApiKey?: string;
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
    aiProvider: value.AI_PROVIDER,
    aiModel: value.AI_MODEL,
    ...(value.AI_MODEL_DEEP ? { aiDeepModel: value.AI_MODEL_DEEP } : {}),
    aiTranscriptionModel: value.AI_TRANSCRIPTION_MODEL,
    aiVoiceMaxDurationSeconds: value.AI_VOICE_MAX_DURATION_SECONDS,
    aiVoiceMaxBytes: value.AI_VOICE_MAX_BYTES,
    aiConsentVersion: value.AI_CONSENT_VERSION,
    aiPricing: value.AI_PRICING_JSON ?? {},
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
  if (config.aiProvider === "openai" && !config.aiPricing[config.aiTranscriptionModel]?.audioUsdPerMinute) warnings.push(`AI_PRICING_JSON has no audio pricing for ${config.aiTranscriptionModel}; voice spend is not estimated`);
  if (config.aiProvider !== "openai") warnings.push(`AI_PROVIDER=${config.aiProvider}: voice transcription is unavailable, only OpenAI transcribes`);
  return warnings;
}

