import { Module } from "@nestjs/common";
import { ConfigModule } from "../config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { TelegramService } from "./telegram.service.js";

@Module({ imports: [ConfigModule, DatabaseModule], providers: [TelegramService], exports: [TelegramService] })
export class TelegramModule {}
