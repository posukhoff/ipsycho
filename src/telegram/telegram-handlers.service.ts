import { Injectable, OnModuleInit } from "@nestjs/common";
import { OnboardingService } from "./handlers/onboarding.service.js";
import { SettingsCommandsService } from "./handlers/settings-commands.service.js";
import { SystemCommandsService } from "./handlers/system-commands.service.js";
import { TaskCallbacksService } from "./handlers/task-callbacks.service.js";
import { TextService } from "./handlers/text.service.js";
import { TelegramConversationHandlersService } from "./telegram-conversation-handlers.service.js";
import { TelegramService } from "./telegram.service.js";

export { canCreateRegistrationInvite, registrationTokenFromStart } from "./handlers/system-commands.service.js";
export { deterministicCopy } from "./copy/onboarding.js";
export { guideText, helpText } from "./copy/help.js";

/**
 * Registration order is the dispatch order: commands and buttons first, then free text,
 * then voice, and last the fallback that answers any message nothing else handled.
 */
@Injectable()
export class TelegramHandlersService implements OnModuleInit {
  constructor(
    private readonly telegram: TelegramService,
    private readonly system: SystemCommandsService,
    private readonly settings: SettingsCommandsService,
    private readonly onboarding: OnboardingService,
    private readonly taskCallbacks: TaskCallbacksService,
    private readonly text: TextService,
    private readonly conversation: TelegramConversationHandlersService,
  ) {}

  onModuleInit(): void {
    const bot = this.telegram.bot;
    this.system.register(bot);
    this.settings.register(bot);
    this.onboarding.register(bot);
    this.taskCallbacks.register(bot);
    this.conversation.register(bot);
    this.text.register(bot);
    this.text.registerFallback(bot);
  }
}
