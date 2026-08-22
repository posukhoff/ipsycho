import { Module } from "@nestjs/common";
import { ConfigModule } from "../config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { TelegramModule } from "../telegram/telegram.module.js";
import { BriefingContentService } from "./briefing-content.service.js";
import { BriefingQueueService } from "./briefing-queue.service.js";
import { BriefingSchedulingService } from "./briefing-scheduling.service.js";

@Module({
  imports: [ConfigModule, DatabaseModule, TelegramModule],
  providers: [BriefingContentService, BriefingQueueService, BriefingSchedulingService],
  exports: [BriefingContentService, BriefingSchedulingService],
})
export class BriefingsModule {}
