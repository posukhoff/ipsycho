import { Controller, Get, UseGuards } from "@nestjs/common";
import { ContextService } from "../../context/context.service.js";
import { ProfileResponseSchema, type ProfileResponse } from "../contracts/index.js";
import { apiRoute } from "../http/routes.js";
import { CurrentUser, InitDataGuard, type WebAuthContext } from "../auth/index.js";
import { presentMemory } from "./memory.presenter.js";

/**
 * More profile facts than a person accumulates, and far past the thirty the chat reads for one
 * model turn: this list is the user's own view of what is stored, and a bound tuned for a prompt
 * would silently hide the oldest of it. Anything past this is still reachable — and editable —
 * through `GET /memory?type=context`, which pages in SQL.
 */
const PROFILE_READ_LIMIT = 200;

/**
 * `GET /profile` — the read side of `/context`.
 *
 * It is not a second store: these are `memory_items` of type `context`, the durable facts the
 * conversation builds up, in the same row shape the memory screen uses. Editing and deleting them
 * goes through `/memory/:id`, so there is one write path for one table.
 *
 * Building the profile stays a conversation — `/context` opens a topic and the agent asks — because
 * a form cannot ask the follow-up question that is the whole value of it.
 */
@Controller(apiRoute("profile"))
@UseGuards(InitDataGuard)
export class WebProfileController {
  constructor(private readonly context: ContextService) {}

  @Get()
  async profile(@CurrentUser() user: WebAuthContext): Promise<ProfileResponse> {
    const rows = await this.context.profileOverview(user.access.workspaceId, user.access.user.id, PROFILE_READ_LIMIT);
    return ProfileResponseSchema.parse({
      rows: rows.map(presentMemory),
      // Null until the user has been invited to build one at least once; the screen shows the
      // invitation instead of an empty list in that case.
      invitedAt: user.settings.profileInvitedAt?.toISOString() ?? null,
    } satisfies ProfileResponse);
  }
}
