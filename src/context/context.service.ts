import { Injectable } from "@nestjs/common";
import { normalizeTopicDirective, type TopicDirective } from "../core/context-policy.js";
import { idleGoals, type IdleGoal } from "../core/goal-attention.js";
import { ContextRepository } from "./context.repository.js";
import { DomainRuleError } from "../core/errors.js";

const TOPIC_RETENTION_MS = 90 * 24 * 60 * 60_000;

@Injectable()
export class ContextService {
  constructor(private readonly repository: ContextRepository) {}

  /**
   * Goals for one filter. The repository already returns active, paused and completed together,
   * so the filter is applied here rather than as a third query shape.
   */
  async goalsOverview(workspaceId: string, status?: "active" | "paused" | "completed", limit?: number) {
    const rows = await this.repository.listGoalsWithTasks(workspaceId, limit);
    return status ? rows.filter((row) => row.goal.status === status) : rows;
  }

  /** Active goals that nothing has moved for a while, longest first; the week card names them. */
  async idleGoals(workspaceId: string, now = new Date()): Promise<IdleGoal[]> {
    const rows = await this.repository.listGoalActivity(workspaceId);
    return idleGoals(
      rows.map((row) => ({ id: row.id, title: row.title, reviewEnabled: row.reviewEnabled, lastActivityAt: new Date(row.lastActivityAt) })),
      now,
    );
  }

  async findGoalOverview(workspaceId: string, goalId: string) {
    const rows = await this.repository.listGoalsWithTasks(workspaceId);
    return rows.find((row) => row.goal.id === goalId) ?? null;
  }

  findActiveTopic(workspaceId: string, userId: string) {
    return this.repository.findActiveTopic(workspaceId, userId);
  }

  /**
   * Apply the model's topic directive after a successful turn. There is no topic id in the
   * contract: `continue` and `resolve` address the active topic, `new` opens one, `none`
   * pauses continuity. An unusable directive degrades through `normalizeTopicDirective`
   * instead of failing, so the topic layer never blocks a turn whose actions already ran.
   * Returns the topic id the message now belongs to.
   */
  async applyTopicDirective(input: { workspaceId: string; userId: string; messageId: string; directive: TopicDirective; now?: Date }): Promise<string | null> {
    const now = input.now ?? new Date();
    const summaryExpiresAt = new Date(now.getTime() + TOPIC_RETENTION_MS);
    const active = await this.repository.findActiveTopic(input.workspaceId, input.userId);
    const directive = normalizeTopicDirective(input.directive, active !== null);
    if (directive.mode === "none") {
      await this.repository.pauseActiveTopics(input.workspaceId, input.userId, now);
      await this.repository.setMessageTopic(input.workspaceId, input.messageId, null);
      return null;
    }
    if (directive.mode === "new") {
      const topic = await this.repository.createTopic({
        workspaceId: input.workspaceId,
        userId: input.userId,
        title: directive.title!,
        summary: directive.summary!,
        mode: "normal",
        now,
        summaryExpiresAt,
      });
      await this.repository.setMessageTopic(input.workspaceId, input.messageId, topic.id);
      return topic.id;
    }
    // continue | resolve: normalization guarantees an active topic here.
    const updated = await this.repository.updateTopic({
      workspaceId: input.workspaceId,
      userId: input.userId,
      topicId: active!.id,
      summary: directive.summary ?? active!.summary,
      ...(directive.mode === "continue" && directive.title ? { title: directive.title } : {}),
      status: directive.mode === "resolve" ? "resolved" : "active",
      now,
      summaryExpiresAt,
    });
    if (!updated) throw new DomainRuleError("topic state changed");
    await this.repository.setMessageTopic(input.workspaceId, input.messageId, updated.id);
    return updated.id;
  }

  async beginProfile(input: { workspaceId: string; userId: string; now?: Date }): Promise<{ id: string }> {
    const now = input.now ?? new Date();
    return this.repository.createTopic({
      workspaceId: input.workspaceId,
      userId: input.userId,
      title: "Контекст пользователя",
      summary:
        "Пользователь заполняет или редактирует свой устойчивый контекст: предпочтения, режим, ограничения и полезные рабочие нюансы. Сохранять только явно сообщённые факты.",
      mode: "normal",
      now,
      summaryExpiresAt: new Date(now.getTime() + TOPIC_RETENTION_MS),
    });
  }

  profileOverview(workspaceId: string, userId: string, limit?: number) {
    return this.repository.listProfile(workspaceId, userId, limit);
  }

  memoryOverview(workspaceId: string, userId: string) {
    return this.repository.listAllMemory(workspaceId, userId);
  }

  /**
   * One page of what is remembered, plus how much there is.
   *
   * The screen edits and deletes these rows, so the read has to be able to reach all of them: a
   * capped list makes an old fact permanently uncorrectable, which is the opposite of why the
   * screen exists. The counts come from the same filter rather than from the page, so «столько-то
   * скрыто» is a property of the list and not of how far the user has scrolled.
   *
   * The count runs first because it is what decides the page: a request past the end clamps to the
   * last page and returns its rows, rather than an empty list that reads as «nothing left».
   */
  async memoryPage(
    workspaceId: string,
    userId: string,
    options: { page: number; pageSize: number; type?: "note" | "decision" | "preference" | "context" },
  ): Promise<{ rows: Awaited<ReturnType<ContextRepository["listAllMemory"]>>; page: number; pages: number; total: number; sensitive: number }> {
    const counts = await this.repository.countMemory(workspaceId, userId, options.type);
    const pages = Math.max(1, Math.ceil(counts.total / options.pageSize));
    const page = Math.min(Math.max(options.page, 0), pages - 1);
    const rows = await this.repository.listAllMemory(workspaceId, userId, {
      limit: options.pageSize,
      offset: page * options.pageSize,
      ...(options.type ? { type: options.type } : {}),
    });
    return { rows, page, pages, total: counts.total, sensitive: counts.sensitive };
  }

  updateClarificationCount(input: { workspaceId: string; userId: string; topicId: string; askedQuestion: boolean; now?: Date }): Promise<number> {
    return this.repository.updateClarificationCount({ ...input, now: input.now ?? new Date() });
  }

  resetClarificationCount(workspaceId: string, userId: string, topicId: string, now = new Date()): Promise<void> {
    return this.repository.resetClarificationCount(workspaceId, userId, topicId, now);
  }

  findTopic(workspaceId: string, userId: string, topicId: string) {
    return this.repository.findTopic(workspaceId, userId, topicId);
  }

  resolveTopic(workspaceId: string, userId: string, topicId: string, now = new Date()): Promise<boolean> {
    return this.repository.resolveTopic(workspaceId, userId, topicId, now);
  }

  pauseActiveTopics(workspaceId: string, userId: string, now = new Date()): Promise<number> {
    return this.repository.pauseActiveTopics(workspaceId, userId, now);
  }

  scrubExpiredTopicSummaries(now: Date): Promise<number> {
    return this.repository.scrubExpiredTopicSummaries(now);
  }

  findTaskGoalLink(workspaceId: string, taskId: string, goalId: string) {
    return this.repository.findTaskGoalLink(workspaceId, taskId, goalId);
  }

  findMemory(workspaceId: string, userId: string, memoryId: string) {
    return this.repository.findMemory(workspaceId, userId, memoryId);
  }

  findGoal(workspaceId: string, goalId: string) {
    return this.repository.findGoal(workspaceId, goalId);
  }

  /** One goal with its active tasks, addressed by id rather than found inside the capped overview. */
  findGoalWithTasks(workspaceId: string, goalId: string) {
    return this.repository.findGoalWithTasks(workspaceId, goalId);
  }

  /** The goal a task is attached to, with the version an unlink write has to carry. */
  findGoalForTask(workspaceId: string, taskId: string) {
    return this.repository.findGoalForTask(workspaceId, taskId);
  }

  /** The goals one action group created, so a create can answer with the row it actually wrote. */
  listGoalsForActionGroup(workspaceId: string, groupId: string) {
    return this.repository.listGoalsForActionGroup(workspaceId, groupId);
  }
}
