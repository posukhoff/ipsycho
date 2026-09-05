import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser, InitDataGuard, type WebAuthContext } from "../auth/index.js";
import {
  ChecklistWriteRequestSchema,
  CreateTaskRequestSchema,
  OccurrenceStateRequestSchema,
  PageQuerySchema,
  RescheduleRequestSchema,
  SeriesRequestSchema,
  TaskListQuerySchema,
  UpdateTaskRequestSchema,
  UuidSchema,
  type ChecklistWriteRequest,
  type CreateTaskRequest,
  type OccurrenceStateRequest,
  type PageQuery,
  type PausedSeriesResponse,
  type RescheduleOptions,
  type RescheduleRequest,
  type SeriesRequest,
  type TaskDetail,
  type TaskListQuery,
  type TaskListResponse,
  type TaskMutationResponse,
  type TodayResponse,
  type UpdateTaskRequest,
} from "../contracts/index.js";
import { apiRoute, zodBody, zodParam, zodQuery } from "../http/index.js";
import { WebTasksService } from "./web-tasks.service.js";

/**
 * The task screens.
 *
 * `:id` is a task id or an occurrence id, and the service resolves either: the launch button on a
 * push carries `#/task/<occurrenceId>` (design.md § 2) while a list line carries the task. Both
 * lookups are workspace-scoped, so a foreign id answers `not_found` exactly like one that never
 * existed — the fragment is attacker-influenced whenever a link is shared.
 *
 * `today` and `paused` are declared before `:id` because Nest matches routes in declaration order
 * and `/tasks/today` is otherwise read as a task whose id is the word «today».
 */
@Controller(apiRoute("tasks"))
@UseGuards(InitDataGuard)
export class WebTasksController {
  constructor(private readonly tasks: WebTasksService) {}

  @Get()
  list(@CurrentUser() user: WebAuthContext, @Query(zodQuery(TaskListQuerySchema)) query: TaskListQuery): Promise<TaskListResponse> {
    return this.tasks.list(user, query);
  }

  @Get("today")
  today(@CurrentUser() user: WebAuthContext, @Query(zodQuery(PageQuerySchema)) query: PageQuery): Promise<TodayResponse> {
    return this.tasks.today(user, query);
  }

  @Get("paused")
  paused(@CurrentUser() user: WebAuthContext, @Query(zodQuery(PageQuerySchema)) query: PageQuery): Promise<PausedSeriesResponse> {
    return this.tasks.pausedSeries(user, query);
  }

  @Get(":id")
  detail(@CurrentUser() user: WebAuthContext, @Param("id", zodParam(UuidSchema)) id: string): Promise<TaskDetail> {
    return this.tasks.detail(user, id);
  }

  @Post()
  @HttpCode(200)
  create(@CurrentUser() user: WebAuthContext, @Body(zodBody(CreateTaskRequestSchema)) body: CreateTaskRequest): Promise<TaskMutationResponse> {
    return this.tasks.create(user, body);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: WebAuthContext,
    @Param("id", zodParam(UuidSchema)) id: string,
    @Body(zodBody(UpdateTaskRequestSchema)) body: UpdateTaskRequest,
  ): Promise<TaskMutationResponse> {
    return this.tasks.update(user, id, body);
  }

  @Post(":id/state")
  @HttpCode(200)
  setState(
    @CurrentUser() user: WebAuthContext,
    @Param("id", zodParam(UuidSchema)) id: string,
    @Body(zodBody(OccurrenceStateRequestSchema)) body: OccurrenceStateRequest,
  ): Promise<TaskMutationResponse> {
    return this.tasks.setState(user, id, body);
  }

  @Get(":id/reschedule")
  rescheduleOptions(@CurrentUser() user: WebAuthContext, @Param("id", zodParam(UuidSchema)) id: string): Promise<RescheduleOptions> {
    return this.tasks.rescheduleOptions(user, id);
  }

  @Post(":id/reschedule")
  @HttpCode(200)
  reschedule(
    @CurrentUser() user: WebAuthContext,
    @Param("id", zodParam(UuidSchema)) id: string,
    @Body(zodBody(RescheduleRequestSchema)) body: RescheduleRequest,
  ): Promise<TaskMutationResponse> {
    return this.tasks.reschedule(user, id, body);
  }

  @Post(":id/checklist")
  @HttpCode(200)
  checklist(
    @CurrentUser() user: WebAuthContext,
    @Param("id", zodParam(UuidSchema)) id: string,
    @Body(zodBody(ChecklistWriteRequestSchema)) body: ChecklistWriteRequest,
  ): Promise<TaskMutationResponse> {
    return this.tasks.checklist(user, id, body);
  }

  @Post(":id/series/pause")
  @HttpCode(200)
  pauseSeries(
    @CurrentUser() user: WebAuthContext,
    @Param("id", zodParam(UuidSchema)) id: string,
    @Body(zodBody(SeriesRequestSchema)) body: SeriesRequest,
  ): Promise<TaskMutationResponse> {
    return this.tasks.series(user, id, body, "pause");
  }

  @Post(":id/series/resume")
  @HttpCode(200)
  resumeSeries(
    @CurrentUser() user: WebAuthContext,
    @Param("id", zodParam(UuidSchema)) id: string,
    @Body(zodBody(SeriesRequestSchema)) body: SeriesRequest,
  ): Promise<TaskMutationResponse> {
    return this.tasks.series(user, id, body, "resume");
  }
}
