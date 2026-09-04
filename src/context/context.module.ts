import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { ContextRepository } from "./context.repository.js";
import { ContextService } from "./context.service.js";
import { SettingsModule } from "../settings/settings.module.js";

@Module({
  imports: [DatabaseModule, SettingsModule],
  providers: [ContextRepository, ContextService],
  exports: [ContextRepository, ContextService],
})
export class ContextModule {}
