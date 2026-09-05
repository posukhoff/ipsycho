import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser, InitDataGuard, type WebAuthContext } from "../auth/index.js";
import {
  CreateGoalRequestSchema,
  GoalLinkRequestSchema,
  GoalsQuerySchema,
  UpdateGoalRequestSchema,
  UuidSchema,
  type CreateGoalRequest,
  type GoalDetail,
  type GoalLinkRequest,
  type GoalMutationResponse,
  type GoalsQuery,
  type GoalsResponse,
  type UpdateGoalRequest,
} from "../contracts/index.js";
import { apiRoute, zodBody, zodParam, zodQuery } from "../http/index.js";
import { WebGoalsService } from "./web-goals.service.js";

/**
 * Goals. Every read is scoped to the caller's workspace by the service it calls, so a goal id from
 * another workspace answers `not_found` — the same answer an id that never existed gets.
 */
@Controller(apiRoute("goals"))
@UseGuards(InitDataGuard)
export class WebGoalsController {
  constructor(private readonly goals: WebGoalsService) {}

  @Get()
  list(@CurrentUser() user: WebAuthContext, @Query(zodQuery(GoalsQuerySchema)) query: GoalsQuery): Promise<GoalsResponse> {
    return this.goals.list(user, query);
  }

  @Get(":id")
  detail(@CurrentUser() user: WebAuthContext, @Param("id", zodParam(UuidSchema)) id: string): Promise<GoalDetail> {
    return this.goals.detail(user, id);
  }

  @Post()
  create(@CurrentUser() user: WebAuthContext, @Body(zodBody(CreateGoalRequestSchema)) body: CreateGoalRequest): Promise<GoalMutationResponse> {
    return this.goals.create(user, body);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: WebAuthContext,
    @Param("id", zodParam(UuidSchema)) id: string,
    @Body(zodBody(UpdateGoalRequestSchema)) body: UpdateGoalRequest,
  ): Promise<GoalMutationResponse> {
    return this.goals.update(user, id, body);
  }

  @Post(":id/tasks")
  link(
    @CurrentUser() user: WebAuthContext,
    @Param("id", zodParam(UuidSchema)) id: string,
    @Body(zodBody(GoalLinkRequestSchema)) body: GoalLinkRequest,
  ): Promise<GoalMutationResponse> {
    return this.goals.link(user, id, body);
  }

  @Delete(":id/tasks/:taskId")
  unlink(@CurrentUser() user: WebAuthContext, @Param("id", zodParam(UuidSchema)) id: string, @Param("taskId", zodParam(UuidSchema)) taskId: string): Promise<GoalMutationResponse> {
    return this.goals.unlink(user, id, taskId);
  }
}
