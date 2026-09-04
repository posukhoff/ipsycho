import { Module } from "@nestjs/common";
import { ContextModule } from "../context/context.module.js";
import { ConfigModule } from "../config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { RemindersModule } from "../reminders/reminders.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { ActionsRepository } from "./actions.repository.js";
import { ActionsService } from "./actions.service.js";
import { ActionGroupRepository } from "./action-group.repository.js";

@Module({
  imports: [ConfigModule, DatabaseModule, TasksModule, RemindersModule, ContextModule, SettingsModule],
  providers: [ActionsRepository, ActionGroupRepository, ActionsService],
  exports: [ActionsService],
})
export class ActionsModule {}
