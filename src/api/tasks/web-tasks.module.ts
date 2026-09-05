import { Module } from "@nestjs/common";

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
 */
@Module({})
export class WebTasksModule {}
