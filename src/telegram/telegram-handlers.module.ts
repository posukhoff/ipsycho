import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ActionsModule } from "../actions/actions.module.js";
import { AiModule } from "../ai/ai.module.js";
import { BriefingsModule } from "../briefings/briefings.module.js";
import { ChatModule } from "../chat/chat.module.js";
import { ConfigModule } from "../config.module.js";
import { ContextModule } from "../context/context.module.js";
import { RemindersModule } from "../reminders/reminders.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { TelegramChatReplyService } from "./telegram-chat-reply.service.js";
import { TelegramConversationHandlersService } from "./telegram-conversation-handlers.service.js";
import { TelegramHandlersService } from "./telegram-handlers.service.js";
import { TelegramModule } from "./telegram.module.js";

@Module({
  imports: [ConfigModule, AccessModule, TasksModule, RemindersModule, TelegramModule, ChatModule, ContextModule, ActionsModule, SettingsModule, BriefingsModule, AiModule],
  providers: [TelegramChatReplyService, TelegramConversationHandlersService, TelegramHandlersService],
})
export class TelegramHandlersModule {}
