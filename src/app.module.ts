import { Module } from "@nestjs/common";
import { AccessModule } from "./access/access.module.js";
import { ApiModule } from "./api/api.module.js";
import { BriefingsModule } from "./briefings/briefings.module.js";
import { ConfigModule } from "./config.module.js";
import { isWebAppEnabled } from "./config.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthController } from "./health.controller.js";
import { MaintenanceModule } from "./maintenance/maintenance.module.js";
import { RemindersModule } from "./reminders/reminders.module.js";
import { TasksModule } from "./tasks/tasks.module.js";
import { TelegramHandlersModule } from "./telegram/telegram-handlers.module.js";
import { SingleInstanceService } from "./runtime/single-instance.service.js";

/**
 * `ApiModule.register` is given the flag rather than reading it inside the decorator, so the one
 * place that decides whether the Mini App exists is `isWebAppEnabled`. With the flag off it
 * contributes an empty module and this graph is byte-for-byte the graph that ran before the app
 * was written — no controllers, no filter, no static files.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AccessModule,
    TasksModule,
    RemindersModule,
    BriefingsModule,
    TelegramHandlersModule,
    MaintenanceModule,
    ApiModule.register(isWebAppEnabled()),
  ],
  controllers: [HealthController],
  providers: [SingleInstanceService],
})
export class AppModule {}
