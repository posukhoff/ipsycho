import { Controller, Post, UseGuards } from "@nestjs/common";
import { ChatService } from "../../chat/chat.service.js";
import { ClearHistoryResponseSchema, type ClearHistoryResponse } from "../contracts/index.js";
import { apiRoute } from "../http/routes.js";
import { CurrentUser, InitDataGuard, type WebAuthContext } from "../auth/index.js";

/**
 * `POST /chat/history/clear` — what `/clear` and the settings card's `history:clear` button do.
 *
 * It forgets the conversation the model is allowed to read, and answers with how many messages that
 * was, because the settings screen shows that number next to the button and would otherwise have to
 * refetch to find out what it just did.
 *
 * Nothing else is deleted: the action journal, the tasks and the memory are untouched. This is the
 * one destructive-sounding endpoint that is not behind a confirmation, for the same reason `/clear`
 * is not — it removes context, not state, and the chat has always treated it as cheap.
 */
@Controller(apiRoute("chat/history"))
@UseGuards(InitDataGuard)
export class WebChatHistoryController {
  constructor(private readonly chat: ChatService) {}

  @Post("clear")
  async clear(@CurrentUser() user: WebAuthContext): Promise<ClearHistoryResponse> {
    const cleared = await this.chat.clearConversation(user.access.workspaceId, user.access.user.id);
    return ClearHistoryResponseSchema.parse({ cleared } satisfies ClearHistoryResponse);
  }
}
