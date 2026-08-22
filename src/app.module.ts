import { Module } from "@nestjs/common";
import { AccessModule } from "./access/access.module.js";
import { BriefingsModule } from "./briefings/briefings.module.js";
import { ConfigModule } from "./config.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthController } from "./health.controller.js";
import { MaintenanceModule } from "./maintenance/maintenance.module.js";
import { RemindersModule } from "./reminders/reminders.module.js";
import { TasksModule } from "./tasks/tasks.module.js";
import { TelegramHandlersModule } from "./telegram/telegram-handlers.module.js";
import { SingleInstanceService } from "./runtime/single-instance.service.js";

@Module({
  imports: [ConfigModule, DatabaseModule, AccessModule, TasksModule, RemindersModule, BriefingsModule, TelegramHandlersModule, MaintenanceModule],
  controllers: [HealthController],
  providers: [SingleInstanceService],
})
export class AppModule {}
