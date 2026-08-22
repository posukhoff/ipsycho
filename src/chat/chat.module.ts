import { Module } from "@nestjs/common";
import { ActionsModule } from "../actions/actions.module.js";
import { AiModule } from "../ai/ai.module.js";
import { BriefingsModule } from "../briefings/briefings.module.js";
import { ContextModule } from "../context/context.module.js";
import { MessagesModule } from "../messages/messages.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { TelegramModule } from "../telegram/telegram.module.js";
import { AiRetryService } from "./ai-retry.service.js";
import { ChatService } from "./chat.service.js";

@Module({
  imports: [AiModule, ActionsModule, MessagesModule, TasksModule, ContextModule, BriefingsModule, TelegramModule],
  providers: [ChatService, AiRetryService],
  exports: [ChatService],
})
export class ChatModule {}
