import { Injectable } from "@nestjs/common";
import { ActionsService, type ActionScope } from "../../actions/actions.service.js";
import { ContextService } from "../../context/context.service.js";
import type { ResolvedAction } from "../../core/ai-contract.js";
import { DomainRuleError } from "../../core/errors.js";
import { paginate } from "../../core/task-list-view.js";
import { TasksService } from "../../tasks/tasks.service.js";
import type { WebAuthContext } from "../auth/index.js";
import {
  GoalDetailSchema,
  GoalMutationResponseSchema,
  GoalsResponseSchema,
  type CreateGoalRequest,
  type GoalDetail,
  type GoalLinkRequest,
  type GoalMutationResponse,
  type GoalRow,
  type GoalScope,
  type GoalsQuery,
  type GoalsResponse,
  type UpdateGoalRequest,
} from "../contracts/index.js";
import { ApiError, errorForIssues, pageInfo, rethrowWriteError } from "../http/index.js";
import { presentGoalTaskRow, type TaskRow } from "../tasks/task.presenter.js";

/** The three tabs the goals screen has; `counts` fills the badge on each of them. */
const SCOPES: readonly GoalScope[] = ["active", "paused", "completed"];

/** More goals than any one workspace has; the overview's own cap of thirty would hide a tab. */
const GOAL_READ_LIMIT = 200;

type GoalRecord = NonNullable<Awaited<ReturnType<ContextService["findGoal"]>>>;

/**
 * Goals, split exactly the way `goalsOverviewText` splits them today: the list stays scannable with
 * one row per goal and how much of it is planned, and the tasks themselves live on the goal's own
 * screen.
 *
 * `idleDays` is the one number the bot computes and never showed here. `idleGoals` in
 * `src/core/goal-attention.ts` decides which goal the weekly card raises; reading the same function
 * means the app marks the same goal, rather than inventing a second definition of «ничего не
 * двигалось».
 */
@Injectable()
export class WebGoalsService {
  constructor(
    private readonly context: ContextService,
    private readonly tasks: TasksService,
    private readonly actions: ActionsService,
  ) {}

  async list(user: WebAuthContext, query: GoalsQuery): Promise<GoalsResponse> {
    const { workspaceId } = user.access;
    const [rows, idle] = await Promise.all([this.context.goalsOverview(workspaceId, undefined, GOAL_READ_LIMIT), this.context.idleGoals(workspaceId)]);
    const idleByGoal = new Map(idle.map((goal) => [goal.id, goal.idleDays] as const));
    const counts = {} as Record<GoalScope, number>;
    for (const scope of SCOPES) counts[scope] = rows.filter((row) => row.goal.status === scope).length;
    const scoped = rows.filter((row) => row.goal.status === query.scope);
    const view = paginate(scoped, query.page, query.pageSize);
    return GoalsResponseSchema.parse({
      scope: query.scope,
      goals: view.items.map((row) => presentGoalRow(row.goal, row.tasks.length, idleByGoal.get(row.goal.id) ?? null)),
      page: pageInfo(view, scoped.length, query.pageSize),
      counts,
    } satisfies GoalsResponse);
  }

  async detail(user: WebAuthContext, goalId: string): Promise<GoalDetail> {
    const row = await this.context.findGoalWithTasks(user.access.workspaceId, goalId);
    if (!row) throw ApiError.notFound();
    return this.buildDetail(user, row.goal, row.tasks);
  }

  async create(user: WebAuthContext, body: CreateGoalRequest): Promise<GoalMutationResponse> {
    const action: ResolvedAction = {
      ...this.base(user),
      type: "goal",
      op: "create",
      goalId: null,
      goalVersion: null,
      taskId: null,
      taskVersion: null,
      title: body.title,
      why: body.why,
      targetDate: body.targetLocalDate,
      status: null,
    };
    const groupId = await this.apply(user, [action], null);
    const created = await this.context.listGoalsForActionGroup(user.access.workspaceId, groupId);
    const goal = created[0];
    if (!goal) throw new DomainRuleError("the created goal could not be read back", "create_readback");
    return this.mutationResponse(user, goal.id, groupId);
  }

  async update(user: WebAuthContext, goalId: string, body: UpdateGoalRequest): Promise<GoalMutationResponse> {
    const goal = await this.requireGoal(user, goalId);
    // `null` on a field means «leave it alone», so emptying one needs `clear` — and the action
    // contract has no way to express it: `ResolvedActionOf<"goal">` uses the same `null` for both.
    // Refusing by name is honest; accepting the request and dropping the clear silently is not.
    if (body.clear?.length) throw new DomainRuleError("a goal field cannot be emptied through this action", "goal_clear_unsupported");
    // The same rule, and the same refusal, for the one field the goal action has no slot for at
    // all. `update_goal`'s patch carries title, why, target date and status; `review_enabled` is
    // read by `idleGoals` and written by nothing, on either surface. Answering 200 to a request
    // that changes it would be a write that reports success and does nothing — the failure this
    // whole file exists to avoid.
    if (body.reviewEnabled !== null) throw new DomainRuleError("a goal review cannot be switched through this action", "goal_review_unsupported");
    const action: ResolvedAction = {
      ...this.base(user),
      type: "goal",
      op: "update",
      goalId: goal.id,
      goalVersion: body.expectedVersion,
      taskId: null,
      taskVersion: null,
      title: body.title,
      why: body.why,
      targetDate: body.targetLocalDate,
      status: body.status,
    };
    const groupId = await this.apply(user, [action], goal.version);
    return this.mutationResponse(user, goal.id, groupId);
  }

  async link(user: WebAuthContext, goalId: string, body: GoalLinkRequest): Promise<GoalMutationResponse> {
    const goal = await this.requireGoal(user, goalId);
    // The second id, scoped exactly like the first and like `unlink` below. The write is safe
    // without this — `validateResolved` and `loadLinkPair` both re-read the task inside the
    // caller's workspace — but a foreign id would then come back as `conflict` carrying the goal's
    // version, which reads as "retry" to the client and differs from every other route's answer to
    // an id that is not yours. One rule: an id outside the workspace is a not-found.
    const task = await this.tasks.getTask(user.access.workspaceId, body.taskId);
    if (!task) throw ApiError.notFound();
    const action: ResolvedAction = {
      ...this.base(user),
      type: "goal",
      op: "link",
      goalId: goal.id,
      goalVersion: body.expectedGoalVersion,
      taskId: task.id,
      taskVersion: body.expectedTaskVersion,
      title: null,
      why: null,
      targetDate: null,
      status: null,
    };
    const groupId = await this.apply(user, [action], goal.version);
    return this.mutationResponse(user, goal.id, groupId);
  }

  /**
   * Unlink. `DELETE /goals/:id/tasks/:taskId` carries no body in the contract, so the versions the
   * write needs are read here rather than sent: the pair addresses exactly one link row, and a
   * concurrent change still fails on the version the transaction reads back.
   */
  async unlink(user: WebAuthContext, goalId: string, taskId: string): Promise<GoalMutationResponse> {
    const goal = await this.requireGoal(user, goalId);
    const task = await this.tasks.getTask(user.access.workspaceId, taskId);
    if (!task) throw ApiError.notFound();
    const action: ResolvedAction = {
      ...this.base(user),
      type: "goal",
      op: "unlink",
      goalId: goal.id,
      goalVersion: goal.version,
      taskId: task.id,
      taskVersion: task.version,
      title: null,
      why: null,
      targetDate: null,
      status: null,
    };
    const groupId = await this.apply(user, [action], goal.version);
    return this.mutationResponse(user, goal.id, groupId);
  }

  /* ----------------------------------------------------------------- helpers */

  private async requireGoal(user: WebAuthContext, goalId: string): Promise<GoalRecord> {
    const goal = await this.context.findGoal(user.access.workspaceId, goalId);
    if (!goal) throw ApiError.notFound();
    return goal;
  }

  private async apply(user: WebAuthContext, actions: readonly ResolvedAction[], currentVersion: number | null): Promise<string> {
    const scope = this.scope(user);
    const issues = await this.actions.validateResolved(actions, scope);
    if (issues.length) throw errorForIssues(issues, currentVersion);
    try {
      const applied = await this.actions.applyResolved(actions, scope);
      return applied.groupId;
    } catch (error) {
      rethrowWriteError(error, currentVersion);
    }
  }

  private scope(user: WebAuthContext): ActionScope {
    return { workspaceId: user.access.workspaceId, actorUserId: user.access.user.id, recipientUserId: user.access.user.id, language: user.locale };
  }

  private base(user: WebAuthContext): { intent: "explicit"; timezone: string; reviewTime: string } {
    return { intent: "explicit", timezone: user.settings.timezone, reviewTime: user.settings.morningReferenceTime };
  }

  private async mutationResponse(user: WebAuthContext, goalId: string, undoGroupId: string | null): Promise<GoalMutationResponse> {
    const row = await this.context.findGoalWithTasks(user.access.workspaceId, goalId);
    if (!row) throw ApiError.notFound();
    return GoalMutationResponseSchema.parse({ goal: await this.buildDetail(user, row.goal, row.tasks), undoGroupId } satisfies GoalMutationResponse);
  }

  private async buildDetail(user: WebAuthContext, goal: GoalRecord, tasks: readonly TaskRow[]): Promise<GoalDetail> {
    const now = new Date();
    const { workspaceId } = user.access;
    const taskIds = tasks.map((task) => task.id);
    const [occurrences, checklists, idle] = await Promise.all([
      this.tasks.findCurrentOccurrences(workspaceId, taskIds),
      this.tasks.listChecklistsForContext(workspaceId, taskIds),
      this.context.idleGoals(workspaceId, now),
    ]);
    const idleDays = idle.find((row) => row.id === goal.id)?.idleDays ?? null;
    return GoalDetailSchema.parse({
      goal: presentGoalRow(goal, tasks.length, idleDays),
      tasks: tasks.map((task) => presentGoalTaskRow(task, occurrences.get(task.id) ?? null, checklists.get(task.id) ?? [], goal.title, now)),
    } satisfies GoalDetail);
  }
}

function presentGoalRow(goal: GoalRecord, taskCount: number, idleDays: number | null): GoalRow {
  return {
    id: goal.id,
    version: goal.version,
    title: goal.title,
    why: goal.why ?? null,
    status: goal.status,
    targetLocalDate: goal.targetLocalDate ?? null,
    reviewEnabled: goal.reviewEnabled,
    nextReviewAt: goal.nextReviewAt ? goal.nextReviewAt.toISOString() : null,
    taskCount,
    idleDays,
    updatedAt: goal.updatedAt.toISOString(),
  };
}
