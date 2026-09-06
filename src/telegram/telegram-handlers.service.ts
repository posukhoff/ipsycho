import { Injectable, OnModuleInit } from "@nestjs/common";
import { OnboardingService } from "./handlers/onboarding.service.js";
import { MovedToAppService } from "./handlers/moved-to-app.service.js";
import { SystemCommandsService } from "./handlers/system-commands.service.js";
import { RescheduleCallbacksService } from "./handlers/reschedule-callbacks.service.js";
import { TaskCallbacksService } from "./handlers/task-callbacks.service.js";
import { TextService } from "./handlers/text.service.js";
import { TelegramConversationHandlersService } from "./telegram-conversation-handlers.service.js";
import { TelegramService } from "./telegram.service.js";

export { canCreateRegistrationInvite, registrationTokenFromStart } from "./handlers/system-commands.service.js";
export { deterministicCopy } from "./copy/onboarding.js";
export { helpText } from "./copy/help.js";

/**
 * Registration order is the dispatch order: commands and buttons first, then free text,
 * then voice, and last the fallback that answers any message nothing else handled.
 */
@Injectable()
export class TelegramHandlersService implements OnModuleInit {
  constructor(
    private readonly telegram: TelegramService,
    private readonly system: SystemCommandsService,
    private readonly onboarding: OnboardingService,
    private readonly taskCallbacks: TaskCallbacksService,
    private readonly rescheduleCallbacks: RescheduleCallbacksService,
    private readonly text: TextService,
    private readonly conversation: TelegramConversationHandlersService,
    private readonly moved: MovedToAppService,
  ) {}

  onModuleInit(): void {
    const bot = this.telegram.bot;
    this.system.register(bot);
    this.onboarding.register(bot);
    this.taskCallbacks.register(bot);
    this.rescheduleCallbacks.register(bot);
    this.conversation.register(bot);
    // Last of the button handlers: the removed screens' patterns answer only what nothing above claimed.
    this.moved.register(bot);
    this.text.register(bot);
    this.text.registerFallback(bot);
  }
}
