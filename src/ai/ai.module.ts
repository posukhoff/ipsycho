import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { ConfigModule } from "../config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { AI_PROVIDER } from "./ai-provider.js";
import { AiRepository } from "./ai.repository.js";
import { AiService } from "./ai.service.js";
import { DeepSeekProvider } from "./deepseek.provider.js";
import { GeminiProvider } from "./gemini.provider.js";
import { OpenAiProvider } from "./openai.provider.js";
import { TranscriptionService } from "./transcription.service.js";

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [
    AiRepository,
    AiService, TranscriptionService,
    {
      provide: AI_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        if (config.aiProvider === "openai") return new OpenAiProvider(config);
        if (config.aiProvider === "gemini") return new GeminiProvider(config);
        if (config.aiProvider === "deepseek") return new DeepSeekProvider(config);
        const exhaustive: never = config.aiProvider;
        throw new Error(`Unsupported AI provider: ${exhaustive}`);
      },
    },
  ],
  exports: [AiService, TranscriptionService],
})
export class AiModule {}
