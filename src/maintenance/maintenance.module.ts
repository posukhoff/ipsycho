import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ActionsModule } from "../actions/actions.module.js";
import { AiModule } from "../ai/ai.module.js";
import { ConfigModule } from "../config.module.js";
import { ContextModule } from "../context/context.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { TelegramModule } from "../telegram/telegram.module.js";
import { MessagesModule } from "../messages/messages.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { RemindersModule } from "../reminders/reminders.module.js";
import { MaintenanceService } from "./maintenance.service.js";

@Module({
  imports: [ConfigModule, DatabaseModule, AccessModule, ActionsModule, AiModule, MessagesModule, ContextModule, TasksModule, RemindersModule, SettingsModule, TelegramModule],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
