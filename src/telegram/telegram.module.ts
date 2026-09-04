import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ConfigModule } from "../config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { TelegramUpdatesRepository } from "./telegram-updates.repository.js";
import { TelegramService } from "./telegram.service.js";

@Module({
  imports: [ConfigModule, DatabaseModule, AccessModule, SettingsModule],
  providers: [TelegramUpdatesRepository, TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
