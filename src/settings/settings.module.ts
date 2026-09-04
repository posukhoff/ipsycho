import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { SettingsRepository } from "./settings.repository.js";
import { SettingsService } from "./settings.service.js";

@Module({ imports: [DatabaseModule], providers: [SettingsRepository, SettingsService], exports: [SettingsService] })
export class SettingsModule {}
