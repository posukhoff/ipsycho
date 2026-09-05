import { Module } from "@nestjs/common";
import { AccessModule } from "../../access/access.module.js";
import { AiModule } from "../../ai/ai.module.js";
import { ChatModule } from "../../chat/chat.module.js";
import { ConfigModule } from "../../config.module.js";
import { SettingsModule } from "../../settings/settings.module.js";
import { MeController } from "./me.controller.js";
import { InitDataGuard } from "./init-data.guard.js";
import { ApiIpRateLimiter, ApiUserRateLimiter } from "./rate-limiter.js";

/**
 * `initData` authentication, and the infrastructure the other API modules consume.
 *
 * It owns `GET /api/v1/me` and, more importantly, the guard. Groups 2–4 use it like this:
 *
 * ```ts
 * @Module({ imports: [WebAuthModule, TasksModule], controllers: [WebTasksController] })
 * export class WebTasksModule {}
 *
 * @Controller(apiRoute("tasks"))
 * @UseGuards(InitDataGuard)
 * export class WebTasksController {
 *   @Get() list(@CurrentUser() user: WebAuthContext) { … }
 * }
 * ```
 *
 * A guard named in `@UseGuards` is *constructed* in the injector of the module that names it, not in
 * the one that exported it, so everything `InitDataGuard` asks for has to be resolvable from there
 * too. That is why `ConfigModule`, `AccessModule` and `SettingsModule` are re-exported: importing
 * this module brings the guard and its dependencies in one line, instead of four modules repeating
 * the same three imports for a class none of them names.
 *
 * The limiters are stateful singletons on purpose. Providing them again in another module would
 * give that module its own counters, and the flood would be permitted once per module; importing
 * them — including through this re-export — shares the one instance.
 */
@Module({
  imports: [ConfigModule, AccessModule, SettingsModule, AiModule, ChatModule],
  controllers: [MeController],
  providers: [InitDataGuard, ApiIpRateLimiter, ApiUserRateLimiter],
  exports: [InitDataGuard, ApiIpRateLimiter, ApiUserRateLimiter, ConfigModule, AccessModule, SettingsModule],
})
export class WebAuthModule {}
