import { Body, Controller, Delete, Get, Param, Patch, Query, UseGuards } from "@nestjs/common";
import { ActionsService, type ActionScope } from "../../actions/actions.service.js";
import { ContextService } from "../../context/context.service.js";
import type { ResolvedActionOf } from "../../core/ai-contract.js";
import {
  MemoryDeleteRequestSchema,
  MemoryMutationResponseSchema,
  MemoryPatchRequestSchema,
  MemoryQuerySchema,
  MemoryResponseSchema,
  UuidSchema,
  type MemoryDeleteRequest,
  type MemoryMutationResponse,
  type MemoryPatchRequest,
  type MemoryQuery,
  type MemoryResponse,
} from "../contracts/index.js";
import { ApiError } from "../http/api-error.js";
import { apiRoute } from "../http/routes.js";
import { zodBody, zodParam, zodQuery } from "../http/zod-validation.pipe.js";
import { CurrentUser, InitDataGuard, type WebAuthContext } from "../auth/index.js";
import { apiErrorForIssues, rethrowWriteError } from "../settings/action-errors.js";
import { presentMemory, type MemoryItem } from "./memory.presenter.js";

/**
 * What the bot remembers — the read side of `/memory`, plus the edit and delete the chat has never
 * had a deterministic path for.
 *
 * Workspace isolation is `ContextService.findMemory`, which scopes on `workspaceId` **and**
 * `userId`: an id from another workspace comes back null and answers `not_found`, the same envelope
 * as an id that does not exist.
 *
 * Sensitive entries are the reason this file is longer than it looks. A fact marked sensitive is
 * hidden from the model, so the user has no way to notice a wrong one through the conversation; the
 * screen is the only place it can be corrected, and every write that touches one — editing it,
 * marking one, unmarking one, deleting one — carries an explicit confirmation. `DELETE` therefore
 * takes a body, which is unusual on purpose: if a proxy strips it the request fails the contract
 * loudly instead of deleting a sensitive fact with no confirmation at all.
 */
@Controller(apiRoute("memory"))
@UseGuards(InitDataGuard)
export class WebMemoryController {
  constructor(
    private readonly context: ContextService,
    private readonly actions: ActionsService,
  ) {}

  /**
   * One page, cut in SQL rather than out of a capped read.
   *
   * The rows on this screen are edited and deleted, so a read that stopped at the newest fifty
   * would make the fifty-first permanently uncorrectable — the opposite of what the screen is for.
   * `memoryPage` therefore pages with an offset and counts with the same filter, which also makes
   * `sensitiveCount` a property of the whole list instead of a property of the page that happened
   * to load. Whole rows come back, so no `findMemory` per row is needed to learn the version every
   * write below is checked against.
   */
  @Get()
  async list(@CurrentUser() user: WebAuthContext, @Query(zodQuery(MemoryQuerySchema)) query: MemoryQuery): Promise<MemoryResponse> {
    const { rows, page, pages, total, sensitive } = await this.context.memoryPage(user.access.workspaceId, user.access.user.id, {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.type ? { type: query.type } : {}),
    });
    return MemoryResponseSchema.parse({
      rows: rows.map(presentMemory),
      page: { page, pages, pageSize: query.pageSize, total, hasMore: page * query.pageSize + rows.length < total },
      // Counted over everything the filter selects, not over the page, so the screen can say how
      // much is hidden without walking the list.
      sensitiveCount: sensitive,
    } satisfies MemoryResponse);
  }

  @Patch(":id")
  async patch(
    @CurrentUser() user: WebAuthContext,
    @Param("id", zodParam(UuidSchema)) id: string,
    @Body(zodBody(MemoryPatchRequestSchema)) body: MemoryPatchRequest,
  ): Promise<MemoryMutationResponse> {
    const item = await this.require(user, id);
    if (item.version !== body.expectedVersion) throw ApiError.conflict(item.version);
    // `update_memory` patches content and sensitivity only; a fact that changes kind is a different
    // fact. Refusing loudly beats accepting the field and dropping it.
    if (body.type !== null && body.type !== item.type) throw ApiError.domainRule("memory_type_immutable");
    if (body.content === null && body.sensitive === null) throw ApiError.validationFailed(["content", "sensitive"]);
    if (body.content !== null && !body.content.trim()) throw ApiError.validationFailed(["content"]);
    this.requireSensitiveConfirmation(item, body.sensitive ?? item.sensitive, body.confirmSensitive);

    const groupId = await this.journal(
      user,
      { op: "update", memoryId: item.id, memoryVersion: item.version, kind: null, content: body.content, sensitive: body.sensitive },
      item.version,
    );
    const updated = await this.context.findMemory(user.access.workspaceId, user.access.user.id, id);
    return MemoryMutationResponseSchema.parse({ item: updated ? presentMemory(updated) : null, undoGroupId: groupId } satisfies MemoryMutationResponse);
  }

  @Delete(":id")
  async remove(
    @CurrentUser() user: WebAuthContext,
    @Param("id", zodParam(UuidSchema)) id: string,
    @Body(zodBody(MemoryDeleteRequestSchema)) body: MemoryDeleteRequest,
  ): Promise<MemoryMutationResponse> {
    const item = await this.require(user, id);
    if (item.version !== body.expectedVersion) throw ApiError.conflict(item.version);
    this.requireSensitiveConfirmation(item, item.sensitive, body.confirmSensitive);

    const groupId = await this.journal(user, { op: "delete", memoryId: item.id, memoryVersion: item.version, kind: null, content: null, sensitive: null }, item.version);
    // The row is gone; the journal holds its before-state, which is what Undo restores.
    return MemoryMutationResponseSchema.parse({ item: null, undoGroupId: groupId } satisfies MemoryMutationResponse);
  }

  private async require(user: WebAuthContext, id: string): Promise<MemoryItem> {
    const item = await this.context.findMemory(user.access.workspaceId, user.access.user.id, id);
    if (!item) throw ApiError.notFound();
    return item;
  }

  /** Sensitive now, or sensitive after this write: either way the client has to say so out loud. */
  private requireSensitiveConfirmation(item: MemoryItem, willBeSensitive: boolean, confirmed: boolean): void {
    if ((item.sensitive || willBeSensitive) && !confirmed) throw ApiError.domainRule("sensitive_confirmation_required");
  }

  /** Every write is the `memory` action the model's edits take, so Undo restores the same way. */
  private async journal(
    user: WebAuthContext,
    fields: Pick<ResolvedActionOf<"memory">, "op" | "memoryId" | "memoryVersion" | "kind" | "content" | "sensitive">,
    version: number,
  ): Promise<string> {
    const action: ResolvedActionOf<"memory"> = {
      type: "memory",
      intent: "explicit",
      timezone: user.settings.timezone,
      reviewTime: user.settings.morningReferenceTime,
      ...fields,
    };
    const scope: ActionScope = {
      workspaceId: user.access.workspaceId,
      actorUserId: user.access.user.id,
      recipientUserId: user.access.user.id,
      language: user.settings.pinnedLanguage ?? user.locale,
    };
    try {
      const issues = await this.actions.validateResolved([action], scope);
      if (issues.length) throw apiErrorForIssues(issues, version);
      return (await this.actions.applyResolved([action], scope)).groupId;
    } catch (error) {
      rethrowWriteError(error, version);
    }
  }
}
