import { Injectable } from "@nestjs/common";
import { assessAvoidance, deriveAvoidanceSignals } from "../core/avoidance.js";
import { validateTopicDirective, type TopicDirective } from "../core/context-policy.js";
import { profileOnboardingState } from "../core/profile-onboarding.js";
import { ContextRepository } from "./context.repository.js";

const TOPIC_RETENTION_MS = 90 * 24 * 60 * 60_000;

@Injectable()
export class ContextService {
  constructor(private readonly repository: ContextRepository) {}

  goalsOverview(workspaceId: string) {
    return this.repository.listGoalsWithTasks(workspaceId);
  }

  async buildAiContext(input: { workspaceId: string; userId: string; query: string; now?: Date }) {
    const [topics, memories, profile, goals, openOccurrences, profileInvitedAt] = await Promise.all([
      this.repository.listTopics(input.workspaceId, input.userId),
      this.repository.searchMemory(input.workspaceId, input.userId, input.query, 5),
      this.repository.listProfile(input.workspaceId, input.userId),
      this.repository.listGoalsForContext(input.workspaceId),
      this.repository.listOpenOccurrences(input.workspaceId),
      this.repository.profileInvitationState(input.userId),
    ]);
    const taskGoalLinks = await this.repository.listTaskGoalLinks(input.workspaceId, [...new Set(openOccurrences.map((row) => row.task.id))]);
    const aiSafeMemories = memories.filter((item) => !item.sensitive);
    const aiSafeProfile = profile.filter((item) => !item.sensitive);

    const occurrenceIds = openOccurrences.map((row) => row.occurrence.id);
    const [interactionEvents, recentBlockers] = await Promise.all([
      this.repository.listAvoidanceEvents(input.workspaceId, occurrenceIds),
      this.repository.listRecentBlockers(input.workspaceId, occurrenceIds),
    ]);
    const eventTypesByOccurrence = new Map<string, string[]>();
    for (const row of interactionEvents) {
      if (!row.occurrenceId) continue;
      const list = eventTypesByOccurrence.get(row.occurrenceId) ?? [];
      list.push(row.eventType);
      eventTypesByOccurrence.set(row.occurrenceId, list);
    }

    return {
      modelMode: topics.find((topic) => topic.status === "active")?.mode === "analysis" ? "deep" as const : "default" as const,
      topics: topics.map((topic) => ({
        topicId: topic.id,
        title: topic.title,
        summary: topic.summary,
        status: topic.status,
        mode: topic.mode,
        reviewKind: topic.reviewKind,
        clarificationCount: topic.clarificationCount,
        lastMessageAt: topic.lastMessageAt.toISOString(),
      })),
      // Sensitive facts are durable local records, not AI context. A user can still
      // refer to a fact explicitly in chat, but neither retrieval nor a prompt
      // injection can make the provider enumerate sensitive database records.
      memory: aiSafeMemories.map((item) => ({
        memoryId: item.id,
        memoryVersion: item.version,
        type: item.type,
        content: item.content,
        sensitive: item.sensitive,
      })),
      userProfile: aiSafeProfile.map((item) => ({
        memoryId: item.id,
        memoryVersion: item.version,
        content: item.content,
        sensitive: item.sensitive,
      })),
      profileOnboarding: profileOnboardingState({
        profileFactCount: aiSafeProfile.length,
        lastInvitedAt: profileInvitedAt,
        now: input.now ?? new Date(),
      }),
      goals: goals.map((goal) => ({
        goalId: goal.id,
        goalVersion: goal.version,
        title: goal.title,
        why: goal.why,
        status: goal.status,
        reviewEnabled: goal.reviewEnabled,
        targetLocalDate: goal.targetLocalDate,
        nextReviewAt: goal.nextReviewAt?.toISOString() ?? null,
      })),
      taskGoalLinks: taskGoalLinks.map((link) => ({ taskId: link.taskId, goalId: link.goalId })),
      recentBlockers: recentBlockers.filter((item) => item.details).map((item) => ({
        taskId: item.taskId, occurrenceId: item.occurrenceId, blocker: item.details, createdAt: item.createdAt.toISOString(),
      })),
      avoidance: openOccurrences.map(({ occurrence, task }) => {
        const signals = deriveAvoidanceSignals(eventTypesByOccurrence.get(occurrence.id) ?? []);
        const assessment = assessAvoidance(signals);
        return assessment.detected ? {
          taskId: task.id,
          occurrenceId: occurrence.id,
          title: task.title,
          minimumAction: task.minimumAction,
          why: task.why,
          reasons: assessment.reasons,
        } : null;
      }).filter((value): value is NonNullable<typeof value> => value !== null),
    };
  }


  async validateTopicDirective(input: { workspaceId: string; userId: string; directive: TopicDirective }): Promise<string | null> {
    const error = validateTopicDirective(input.directive);
    if (error) return error;
    if (["continue", "switch", "resolve"].includes(input.directive.mode)) {
      const topic = await this.repository.findTopic(input.workspaceId, input.userId, input.directive.topicId!);
      if (!topic) return "topicId is missing or belongs to another user";
    }
    return null;
  }

  async applyTopicDirective(input: {
    workspaceId: string;
    userId: string;
    messageId: string;
    directive: TopicDirective;
    modeSuggestion?: "normal" | "analysis" | null;
    now?: Date;
  }): Promise<string | null> {
    const error = validateTopicDirective(input.directive);
    if (error) throw new Error(error);
    const now = input.now ?? new Date();
    const summaryExpiresAt = new Date(now.getTime() + TOPIC_RETENTION_MS);
    const directive = input.directive;
    if (directive.mode === "none") {
      await this.repository.pauseActiveTopics(input.workspaceId, input.userId, now);
      await this.repository.setMessageTopic(input.workspaceId, input.messageId, null);
      return null;
    }
    if (directive.mode === "new") {
      const topic = await this.repository.createTopic({
        workspaceId: input.workspaceId,
        userId: input.userId,
        title: directive.title!.trim(),
        summary: directive.summary!.trim(),
        mode: input.modeSuggestion ?? "normal",
        now,
        summaryExpiresAt,
      });
      await this.repository.setMessageTopic(input.workspaceId, input.messageId, topic.id);
      return topic.id;
    }
    const existing = await this.repository.findTopic(input.workspaceId, input.userId, directive.topicId!);
    if (!existing) throw new Error("topic is missing or belongs to another user");
    const updated = await this.repository.updateTopic({
      workspaceId: input.workspaceId,
      userId: input.userId,
      topicId: existing.id,
      summary: directive.summary!.trim(),
      ...(directive.title?.trim() && directive.mode !== "resolve" ? { title: directive.title.trim() } : {}),
      status: directive.mode === "resolve" ? "resolved" : "active",
      ...(directive.mode !== "resolve" && input.modeSuggestion ? { mode: input.modeSuggestion } : {}),
      now,
      summaryExpiresAt,
    });
    if (!updated) throw new Error("topic state changed");
    await this.repository.setMessageTopic(input.workspaceId, input.messageId, updated.id);
    return updated.id;
  }

  async beginEveningReview(input: { workspaceId: string; userId: string; now?: Date }): Promise<{ id: string }> {
    return this.beginReview({ ...input, kind: "evening" });
  }

  async beginWeeklyReview(input: { workspaceId: string; userId: string; now?: Date }): Promise<{ id: string }> {
    return this.beginReview({ ...input, kind: "weekly" });
  }

  async beginProfile(input: { workspaceId: string; userId: string; now?: Date }): Promise<{ id: string }> {
    const now = input.now ?? new Date();
    return this.repository.createTopic({
      workspaceId: input.workspaceId,
      userId: input.userId,
      title: "Контекст пользователя",
      summary: "Пользователь заполняет или редактирует свой устойчивый контекст: предпочтения, режим, ограничения и полезные рабочие нюансы. Сохранять только явно сообщённые факты.",
      mode: "normal",
      now,
      summaryExpiresAt: new Date(now.getTime() + TOPIC_RETENTION_MS),
    });
  }

  profileOverview(workspaceId: string, userId: string) {
    return this.repository.listProfile(workspaceId, userId);
  }

  markProfileInvitationShown(userId: string, now = new Date()): Promise<void> {
    return this.repository.markProfileInvitationShown(userId, now);
  }

  private async beginReview(input: { workspaceId: string; userId: string; kind: "evening" | "weekly"; now?: Date }): Promise<{ id: string }> {
    const now = input.now ?? new Date();
    return this.repository.createTopic({
      workspaceId: input.workspaceId,
      userId: input.userId,
      title: input.kind === "evening" ? "Вечерний разбор" : "Планирование недели",
      summary: input.kind === "evening"
        ? "Разбор незавершённых дел за текущий вечер."
        : "Совместное планирование следующей недели: приоритеты, незавершённые задачи и реалистичные сроки. Ничего не переносить без явного выбора пользователя.",
      mode: "normal",
      reviewKind: input.kind,
      now,
      summaryExpiresAt: new Date(now.getTime() + TOPIC_RETENTION_MS),
    });
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
}
