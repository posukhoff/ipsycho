import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { SettingsService } from "./settings.service.js";

@Module({ imports: [DatabaseModule], providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
