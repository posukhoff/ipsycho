import { Module } from "@nestjs/common";
import { AccessModule } from "../../access/access.module.js";
import { ActionsModule } from "../../actions/actions.module.js";
import { AiModule } from "../../ai/ai.module.js";
import { ChatModule } from "../../chat/chat.module.js";
import { ContextModule } from "../../context/context.module.js";
import { RemindersModule } from "../../reminders/reminders.module.js";
import { SettingsModule } from "../../settings/settings.module.js";
import { TasksModule } from "../../tasks/tasks.module.js";
import { WebAuthModule } from "../auth/web-auth.module.js";
import { WebMemoryController } from "../memory/web-memory.controller.js";
import { WebProfileController } from "../memory/web-profile.controller.js";
import { WebRemindersController } from "../reminders/web-reminders.controller.js";
import { WebAccountController } from "./account.controller.js";
import { WebChatHistoryController } from "./chat-history.controller.js";
import { WebConsentController } from "./consent.controller.js";
import { WebSettingsController } from "./web-settings.controller.js";

/**
 * Group 3: reminders, settings and memory.
 *
 * - `GET    /api/v1/reminders`
 * - `POST   /api/v1/reminders/:deliveryId/{snooze,repeat}`
 * - `DELETE /api/v1/reminders/:deliveryId`
 * - `GET    /api/v1/settings`, `PATCH /api/v1/settings`
 * - `GET    /api/v1/settings/timezones`          — the picker's search
 * - `GET    /api/v1/memory`, `PATCH /api/v1/memory/:id`, `DELETE /api/v1/memory/:id`
 * - `GET    /api/v1/profile`
 * - `POST   /api/v1/chat/history/clear`
 * - `GET    /api/v1/consent`, `POST /api/v1/consent/{grant,revoke}`
 * - `POST   /api/v1/account/delete`
 *
 * Account deletion lives here rather than in its own group: it is the settings screen's last row,
 * and it is the one endpoint with no counterpart — restore stays a chat command, because the guard
 * refuses a deletion-pending user by design.
 *
 * `WebAuthModule` is imported, never re-provided: it brings the guard, the two rate limiters as the
 * single instances per process they have to be, and — re-exported — the modules `InitDataGuard`
 * injects, because a guard named in `@UseGuards` is *constructed* in the module that names it.
 * `AccessModule` and `SettingsModule` are named again below for this module's own controllers.
 *
 * This module also owns `src/api/reminders/**` and `src/api/memory/**`.
 */
@Module({
  imports: [WebAuthModule, SettingsModule, AccessModule, RemindersModule, ContextModule, ActionsModule, ChatModule, AiModule, TasksModule],
  controllers: [WebSettingsController, WebRemindersController, WebMemoryController, WebProfileController, WebConsentController, WebChatHistoryController, WebAccountController],
})
export class WebSettingsModule {}
