import { Module } from "@nestjs/common";
import { ActionsModule } from "../../actions/actions.module.js";
import { ContextModule } from "../../context/context.module.js";
import { RemindersModule } from "../../reminders/reminders.module.js";
import { TasksModule } from "../../tasks/tasks.module.js";
import { WebAuthModule } from "../auth/index.js";
import { WebGoalsController } from "../goals/web-goals.controller.js";
import { WebGoalsService } from "../goals/web-goals.service.js";
import { WebTasksController } from "./web-tasks.controller.js";
import { WebTasksService } from "./web-tasks.service.js";
import { WebUndoController } from "./web-undo.controller.js";

/**
 * Group 2: tasks and goals.
 *
 * Reserved endpoints (`ENDPOINTS`, `group: 2`):
 * - `GET    /api/v1/tasks`                       — list by scope, paged
 * - `GET    /api/v1/tasks/today`
 * - `GET    /api/v1/tasks/paused`                — paused series
 * - `GET    /api/v1/tasks/:id`
 * - `POST   /api/v1/tasks`
 * - `PATCH  /api/v1/tasks/:id`
 * - `POST   /api/v1/tasks/:id/state`
 * - `GET    /api/v1/tasks/:id/reschedule`        — reason requirement and preset times
 * - `POST   /api/v1/tasks/:id/reschedule`
 * - `POST   /api/v1/tasks/:id/checklist`
 * - `POST   /api/v1/tasks/:id/series/{pause,resume}`
 * - `POST   /api/v1/undo`
 * - `GET    /api/v1/goals`, `GET /api/v1/goals/:id`
 * - `POST   /api/v1/goals`, `PATCH /api/v1/goals/:id`
 * - `POST   /api/v1/goals/:id/tasks`, `DELETE /api/v1/goals/:id/tasks/:taskId`
 *
 * The static routes (`/tasks/today`, `/tasks/paused`) must be declared before `/tasks/:id`.
 *
 * This module also owns `src/api/goals/**`; one module keeps the two halves of the same screen
 * group in one place, and keeps `api.module.ts` closed to later edits.
 *
 * `WebAuthModule` is imported rather than re-provided: it carries the guard, the two rate limiters
 * — stateful singletons that must exist once per process — and, re-exported, the three modules the
 * guard itself depends on. Everything below `WebAuthModule` in `imports` is this module's own.
 */
@Module({
  imports: [WebAuthModule, TasksModule, ActionsModule, ContextModule, RemindersModule],
  controllers: [WebTasksController, WebGoalsController, WebUndoController],
  providers: [WebTasksService, WebGoalsService],
})
export class WebTasksModule {}
