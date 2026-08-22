import { Module } from "@nestjs/common";
import { ContextModule } from "../context/context.module.js";
import { ConfigModule } from "../config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { RemindersModule } from "../reminders/reminders.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { ActionMutationsRepository } from "./action-mutations.repository.js";
import { ActionsRepository } from "./actions.repository.js";
import { ActionsService } from "./actions.service.js";
import { TaskBatchRepository } from "./task-batch.repository.js";

@Module({
  imports: [ConfigModule, DatabaseModule, TasksModule, RemindersModule, ContextModule, SettingsModule],
  providers: [ActionsRepository, ActionMutationsRepository, TaskBatchRepository, ActionsService],
  exports: [ActionsService],
})
export class ActionsModule {}
