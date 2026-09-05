import { Module } from "@nestjs/common";

/**
 * Group 4: the week plan.
 *
 * Reserved endpoints (`ENDPOINTS`, `group: 4`):
 * - `GET    /api/v1/week`                        — the pool, the current pick, the past week
 * - `POST   /api/v1/week/pick/:taskId`
 * - `DELETE /api/v1/week/pick/:taskId`
 * - `POST   /api/v1/week/take-today/:taskId`
 *
 * `targetWeekStart`, `isPickLive` and `isPickStale` come from `src/core/week-plan.js` and are
 * reused, not reimplemented: the Sunday rule is the whole reason a stale pick is representable.
 */
@Module({})
export class WebWeekModule {}
