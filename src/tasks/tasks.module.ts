import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { RemindersModule } from "../reminders/reminders.module.js";
import { OccurrenceMaintenanceService } from "./occurrence-maintenance.service.js";
import { RecurrenceMaintenanceService } from "./recurrence-maintenance.service.js";
import { TasksRepository } from "./tasks.repository.js";
import { TasksService } from "./tasks.service.js";

@Module({
  imports: [DatabaseModule, RemindersModule],
  providers: [TasksRepository, TasksService, OccurrenceMaintenanceService, RecurrenceMaintenanceService],
  exports: [TasksRepository, TasksService],
})
export class TasksModule {}
