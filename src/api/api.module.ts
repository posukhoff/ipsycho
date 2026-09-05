import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ApiExceptionFilter } from "./http/api-exception.filter.js";
import { WebAuthModule } from "./auth/web-auth.module.js";
import { WebTasksModule } from "./tasks/web-tasks.module.js";
import { WebSettingsModule } from "./settings/web-settings.module.js";
import { WebWeekModule } from "./week/web-week.module.js";

/**
 * The Mini App's presentation layer, behind `WEBAPP_ENABLED`.
 *
 * `register()` reads the flag itself instead of taking it from `APP_CONFIG`, because `AppModule`'s
 * `imports` array is evaluated before anything is injected. When the flag is off it returns an
 * empty module: no controllers, no providers, no exception filter — so a production process with
 * the flag off resolves exactly the graph it resolved before this change existed. That is the
 * property rollout step 1 depends on, and `tests/app/webapp-flag.test.mjs` asserts it.
 *
 * The four sub-modules are imported from here from the start, empty. Groups 1–4 fill their own
 * file and never touch this one, which is the only reason four agents can add controllers in
 * parallel without a merge conflict in the module that wires them.
 */
@Module({})
export class ApiModule {
  static register(enabled: boolean): DynamicModule {
    if (!enabled) return { module: ApiModule };
    return {
      module: ApiModule,
      imports: [WebAuthModule, WebTasksModule, WebSettingsModule, WebWeekModule],
      providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
    };
  }
}
