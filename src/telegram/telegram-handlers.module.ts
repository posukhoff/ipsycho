import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ActionsModule } from "../actions/actions.module.js";
import { AiModule } from "../ai/ai.module.js";
import { ChatModule } from "../chat/chat.module.js";
import { ConfigModule } from "../config.module.js";
import { ContextModule } from "../context/context.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { RemindersModule } from "../reminders/reminders.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { OnboardingService } from "./handlers/onboarding.service.js";
import { MovedToAppService } from "./handlers/moved-to-app.service.js";
import { SystemCommandsService } from "./handlers/system-commands.service.js";
import { RescheduleCallbacksService } from "./handlers/reschedule-callbacks.service.js";
import { TaskCallbacksService } from "./handlers/task-callbacks.service.js";
import { TextService } from "./handlers/text.service.js";
import { TaskCardService } from "./handlers/task-card.service.js";
import { TelegramChatReplyService } from "./telegram-chat-reply.service.js";
import { TelegramConversationHandlersService } from "./telegram-conversation-handlers.service.js";
import { TelegramHandlersService } from "./telegram-handlers.service.js";
import { TelegramModule } from "./telegram.module.js";

@Module({
  imports: [ConfigModule, DatabaseModule, AccessModule, TasksModule, RemindersModule, TelegramModule, ChatModule, ContextModule, ActionsModule, SettingsModule, AiModule],
  providers: [
    TelegramChatReplyService,
    TaskCardService,
    OnboardingService,
    SystemCommandsService,
    TaskCallbacksService,
    RescheduleCallbacksService,
    MovedToAppService,
    TextService,
    TelegramConversationHandlersService,
    TelegramHandlersService,
  ],
})
export class TelegramHandlersModule {}
