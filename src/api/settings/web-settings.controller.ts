import { Body, Controller, Get, Patch, Query, UseGuards } from "@nestjs/common";
import { ActionsService, type ActionScope } from "../../actions/actions.service.js";
import { ChatService } from "../../chat/chat.service.js";
import { SettingsService } from "../../settings/settings.service.js";
import {
  SettingsMutationResponseSchema,
  SettingsPatchRequestSchema,
  SettingsResponseSchema,
  TimezoneSearchQuerySchema,
  TimezoneSearchResponseSchema,
  type SettingsMutationResponse,
  type SettingsPatchRequest,
  type SettingsResponse,
  type TimezoneSearchQuery,
  type TimezoneSearchResponse,
} from "../contracts/index.js";
import { ApiError } from "../http/api-error.js";
import { apiRoute } from "../http/routes.js";
import { zodBody, zodQuery } from "../http/zod-validation.pipe.js";
import { CurrentUser, InitDataGuard, presentSettings, type WebAuthContext, type WebSettingsRow } from "../auth/index.js";
import { apiErrorForIssues, rethrowWriteError } from "./action-errors.js";
import { planSettingsChange } from "./settings-change.plan.js";
import { searchTimezones } from "./timezone-search.js";

/**
 * The settings screen: `GET /settings`, `PATCH /settings` and the timezone picker's search.
 *
 * The read is `presentSettings`, the same mapping `GET /me` embeds — one function, because the
 * bootstrap call and the settings screen disagreeing about what the user configured is a bug nobody
 * would look for. The write is one `SettingsChange` through `ActionsService`, which is the road the
 * seven settings commands take, so a change made here journals and undoes like a change made there.
 *
 * A `PATCH` answers with the whole screen rather than the field it touched: one change moves three
 * columns often enough (`digest` also stamps `digestTimezone`, `timezone` may move all three) that
 * a partial answer would leave the client rendering a state the server does not have.
 */
@Controller(apiRoute("settings"))
@UseGuards(InitDataGuard)
export class WebSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly actions: ActionsService,
    private readonly chat: ChatService,
  ) {}

  @Get()
  async get(@CurrentUser() user: WebAuthContext): Promise<SettingsResponse> {
    return this.present(user, user.settings);
  }

  @Patch()
  async patch(@CurrentUser() user: WebAuthContext, @Body(zodBody(SettingsPatchRequestSchema)) body: SettingsPatchRequest): Promise<SettingsMutationResponse> {
    const current = user.settings;
    // The version the guard read at the start of this request is the one the action will be checked
    // against, so a mismatch is answered here with the row's own number instead of as a domain rule
    // the client cannot act on.
    if (body.expectedVersion !== current.version) throw ApiError.conflict(current.version);

    const plan = planSettingsChange(body.change, current);
    if (plan.kind === "snooze_until_morning") {
      // `/snooze morning` writes through `SettingsService`, without a journal. Doing anything else
      // here would mean a second definition of «утром» — the reference time, and tomorrow when
      // today's has passed — living in the API.
      await this.settings.snoozeUntilMorning(user.access.user.id);
      return this.mutation(user, null);
    }

    const scope: ActionScope = {
      workspaceId: user.access.workspaceId,
      actorUserId: user.access.user.id,
      recipientUserId: user.access.user.id,
      language: current.pinnedLanguage ?? user.locale,
    };
    let groupId: string;
    try {
      const issues = await this.actions.validateResolved([plan.action], scope);
      if (issues.length) throw apiErrorForIssues(issues, current.version);
      groupId = (await this.actions.applyResolved([plan.action], scope)).groupId;
    } catch (error) {
      rethrowWriteError(error, current.version);
    }

    // The second half of `tzapply:`: the profile zone is copied onto the digest or quiet-hours
    // columns, exactly as the button does, and — exactly as the button does — outside the journal.
    if (plan.copyTimezoneTo) await this.settings.applyProfileTimezone(user.access.user.id, plan.copyTimezoneTo);

    // Undo restores the journalled action and nothing else, so it is offered only when the action
    // *is* the whole change. With a column copy behind it, undoing would put the profile zone back
    // and leave the digest or quiet-hours zone on the new one — a half-undo, which is worse than
    // none because the user believes the change is gone.
    return this.mutation(user, plan.copyTimezoneTo ? null : groupId);
  }

  /**
   * The IANA list, searched server-side. The client ships no timezone table, and the zone that
   * matters is the one this process will schedule against rather than the webview's own.
   */
  @Get("timezones")
  timezones(@Query(zodQuery(TimezoneSearchQuerySchema)) query: TimezoneSearchQuery): TimezoneSearchResponse {
    return TimezoneSearchResponseSchema.parse({ suggestions: searchTimezones(query.q, new Date()) } satisfies TimezoneSearchResponse);
  }

  private async mutation(user: WebAuthContext, undoGroupId: string | null): Promise<SettingsMutationResponse> {
    const updated = await this.settings.get(user.access.user.id);
    // The row existed a moment ago (the guard read it) and the write committed, so its absence is a
    // broken account rather than a caller error — the same answer the guard gives for it.
    if (!updated) throw new ApiError("unavailable");
    return SettingsMutationResponseSchema.parse({ settings: await this.present(user, updated), undoGroupId } satisfies SettingsMutationResponse);
  }

  private async present(user: WebAuthContext, row: WebSettingsRow): Promise<SettingsResponse> {
    const historyMessageCount = await this.chat.historyMessageCount(user.access.workspaceId, user.access.user.id);
    return SettingsResponseSchema.parse(presentSettings(row, { historyMessageCount }) satisfies SettingsResponse);
  }
}
