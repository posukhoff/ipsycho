import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { AccessService, DELETION_GRACE_DAYS } from "../../access/access.service.js";
import { AccountDeleteRequestSchema, AccountDeleteResponseSchema, type AccountDeleteRequest, type AccountDeleteResponse } from "../contracts/index.js";
import { apiRoute, zodBody } from "../http/index.js";
import { CurrentUser, InitDataGuard, type WebAuthContext } from "../auth/index.js";

/**
 * Account deletion, behind the same deterministic confirmation `/delete_account` puts in the chat.
 *
 * The client sends the literal word; there is no «are you sure» the API can infer from a header or
 * a second call. `confirm: "delete"` is a `z.literal`, so a request that merely reaches the endpoint
 * cannot delete an account. What it does is exactly what `account:delete_confirm` does — nothing
 * more: the account moves to `deletion_pending`, pending reminders and briefings are suppressed, and
 * the grace period runs.
 *
 * There is deliberately **no restore endpoint**. A deletion-pending user is refused by
 * `InitDataGuard` — the same refusal an unknown user gets, by design — so the app cannot reach one,
 * and the way back is `/restore` in the chat. `restoreIsChatOnly` is a constant `true` rather than a
 * capability flag: it exists so the deletion screen has to render that sentence (tasks.md § 8.3).
 */
@Controller(apiRoute("account"))
@UseGuards(InitDataGuard)
export class WebAccountController {
  constructor(private readonly access: AccessService) {}

  @Post("delete")
  @HttpCode(200)
  async delete(@CurrentUser() user: WebAuthContext, @Body(zodBody(AccountDeleteRequestSchema)) _body: AccountDeleteRequest): Promise<AccountDeleteResponse> {
    // The internal uuid is what every other endpoint uses; deletion is keyed on the Telegram id,
    // because that is the identity the allowlist and `/restore` are keyed on — and the guard
    // resolved it from a signed payload, never from anything the request body said.
    const deleteAfter = await this.access.requestDeletion(user.access.user.telegramUserId);
    return AccountDeleteResponseSchema.parse({
      deleteAfter: deleteAfter.toISOString(),
      graceDays: DELETION_GRACE_DAYS,
      restoreIsChatOnly: true,
    } satisfies AccountDeleteResponse);
  }
}
