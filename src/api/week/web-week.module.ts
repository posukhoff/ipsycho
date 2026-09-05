import { Module } from "@nestjs/common";
import { ActionsModule } from "../../actions/actions.module.js";
import { TasksModule } from "../../tasks/tasks.module.js";
import { WebAuthModule } from "../auth/index.js";
import { WebWeekController } from "./web-week.controller.js";

/**
 * Group 4: the week plan.
 *
 * Endpoints (`ENDPOINTS`, `group: 4`):
 * - `GET    /api/v1/week`                        — the pool, the current pick, the past week
 * - `POST   /api/v1/week/pick/:taskId`
 * - `DELETE /api/v1/week/pick/:taskId`
 * - `POST   /api/v1/week/take-today/:taskId`
 *
 * `targetWeekStart`, `isPickLive` and `isPickStale` come from `src/core/week-plan.js` and are
 * reused, not reimplemented: the Sunday rule is the whole reason a stale pick is representable.
 *
 * `WebAuthModule` is imported rather than re-provided, so both rate limiters stay the single
 * stateful instances they have to be: providing them again here would give this module its own
 * counters and permit the same flood a second time. It also re-exports the three modules
 * `InitDataGuard` injects, which a module naming the guard in `@UseGuards` has to be able to
 * resolve — Nest constructs the guard here rather than resolving the exported instance.
 *
 * `ActionsModule` is here for one endpoint. «Делаю сегодня» is a real schedule change, so it goes
 * through `ActionsService` like every other write and journals into a group the user can undo;
 * doing it any other way would make Undo lie about what the app did.
 */
@Module({ imports: [WebAuthModule, TasksModule, ActionsModule], controllers: [WebWeekController] })
export class WebWeekModule {}
