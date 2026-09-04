import { Module } from "@nestjs/common";
import { ConfigModule } from "../config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { QueueModule } from "../queue/queue.module.js";
import { TelegramModule } from "../telegram/telegram.module.js";
import { ReminderQueueService } from "./reminder-queue.service.js";
import { ReminderRebuildService } from "./reminder-rebuild.service.js";
import { ReminderSchedulingService } from "./reminder-scheduling.service.js";

@Module({
  imports: [ConfigModule, DatabaseModule, QueueModule, TelegramModule],
  providers: [ReminderQueueService, ReminderSchedulingService, ReminderRebuildService],
  exports: [ReminderQueueService, ReminderSchedulingService],
})
export class RemindersModule {}
