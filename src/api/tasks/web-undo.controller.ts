import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { CurrentUser, InitDataGuard, type WebAuthContext } from "../auth/index.js";
import { UndoRequestSchema, UndoResponseSchema, type UndoRequest, type UndoResponse } from "../contracts/index.js";
import { apiRoute, zodBody } from "../http/index.js";
import { WebTasksService } from "./web-tasks.service.js";

/**
 * `POST /api/v1/undo` — one endpoint for every action group, because Undo is a property of the
 * group, not of the screen that made it. A write answers with `undoGroupId` when the change is
 * truthfully reversible and with `null` when it is not, and this is what the snackbar then calls.
 *
 * It sits at the root rather than under `/tasks` for the same reason: a reminder snooze and a
 * settings change produce the same kind of group, and a second undo route would be a second
 * implementation of `ActionsService.undo`.
 *
 * An expired or already-undone group is a `DomainRuleError` from the claim, which the filter turns
 * into `domain_rule` — the honest answer, not a 200 that says the change is gone when it is not.
 */
@Controller(apiRoute())
@UseGuards(InitDataGuard)
export class WebUndoController {
  constructor(private readonly tasks: WebTasksService) {}

  @Post("undo")
  @HttpCode(200)
  async undo(@CurrentUser() user: WebAuthContext, @Body(zodBody(UndoRequestSchema)) body: UndoRequest): Promise<UndoResponse> {
    return UndoResponseSchema.parse({ undone: await this.tasks.undo(user, body.groupId) } satisfies UndoResponse);
  }
}
