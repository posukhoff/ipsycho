import { Injectable } from "@nestjs/common";
import { BriefingContentService } from "../briefings/briefing-content.service.js";
import { ContextRepository } from "../context/context.repository.js";
import type { RefMap } from "../core/ai-refs.js";
import type { ReviewKind } from "../core/review-policy.js";
import { localDateAt } from "../core/timezone.js";
import { budgetModelContext, composeTurnContext, selectTasksForContext, type ModelContext } from "../core/turn-context.js";
import { parseWeeklyReviewState, type WeeklyReviewState } from "../core/weekly-review-state.js";
import { SettingsService } from "../settings/settings.service.js";
import { TasksService } from "../tasks/tasks.service.js";

export interface TurnContextInput {
  workspaceId: string;
  userId: string;
  timezone: string;
  language?: string | null;
  query: string;
  now: Date;
  /** Forces a review frame; otherwise the active topic's `reviewKind` decides. */
  review?: ReviewKind;
  /** The user pressed a card button and then typed free text: the model sees which task it was about. */
  focus?: { occurrenceId: string; action: "reschedule" | "blocker" };
  /** The live confirmation card, summarised by the caller (the chat layer owns ActionsService). */
  pendingGroup?: { groupId: string; createdAt: Date; titles: string[] } | null;
}

export interface ActiveTopicState {
  topicId: string;
  reviewKind: ReviewKind | null;
  clarificationCount: number;
  reviewState: WeeklyReviewState | null;
  mode: "normal" | "analysis";
}

export interface TurnContext {
  model: ModelContext;
  refs: RefMap;
  activeTopic: ActiveTopicState | null;
  modelMode: "default" | "deep";
  meta: { tasksShown: number; tasksTotal: number; truncated: boolean };
}

/**
 * Assembles what one model call may read: every active task compactly, goals, memory,
 * settings and the topic, all under short ids and local times. Pure composition lives in
 * `src/core/turn-context.ts`; this service only fetches rows and hands the `RefMap` back
 * to the chat layer so the resolver can map the model's `t3` to a UUID it never saw.
 */
@Injectable()
export class TurnContextService {
  constructor(
    private readonly tasks: TasksService,
    private readonly context: ContextRepository,
    private readonly settings: SettingsService,
    private readonly briefings: BriefingContentService,
  ) {}

  async build(input: TurnContextInput): Promise<TurnContext> {
    const { workspaceId, userId, now } = input;
    const [taskData, goals, profile, memoryMatches, settings, topics] = await Promise.all([
      this.tasks.listTasksForContext(workspaceId, input.query),
      this.context.listGoalsForContext(workspaceId),
      this.context.listProfile(workspaceId, userId),
      this.context.searchMemory(workspaceId, userId, input.query, 5),
      this.settings.get(userId),
      this.context.listTopics(workspaceId, userId),
    ]);

    const focusTaskId = input.focus ? this.taskIdOfOccurrence(taskData.occurrencesByTask, input.focus.occurrenceId) : null;
    const mustShow = new Set(taskData.ftsMatchIds);
    if (focusTaskId) mustShow.add(focusTaskId);
    const selection = selectTasksForContext(taskData.tasks, taskData.occurrencesByTask, mustShow, { now, timezone: input.timezone });

    const shownTaskIds = selection.shown.map((task) => task.id);
    const shownOccurrenceIds = shownTaskIds.flatMap((taskId) => (taskData.occurrencesByTask.get(taskId) ?? []).map((occurrence) => occurrence.id));
    const [taskGoalLinks, interactionEvents, blockers, checklistByTask] = await Promise.all([
      this.context.listTaskGoalLinks(workspaceId, shownTaskIds),
      this.context.listAvoidanceEvents(workspaceId, shownOccurrenceIds),
      this.context.listRecentBlockers(workspaceId, shownOccurrenceIds),
      this.tasks.listChecklistsForContext(workspaceId, shownTaskIds),
    ]);
    const eventTypesByOccurrence = new Map<string, string[]>();
    for (const row of interactionEvents) {
      if (!row.occurrenceId) continue;
      const list = eventTypesByOccurrence.get(row.occurrenceId) ?? [];
      list.push(row.eventType);
      eventTypesByOccurrence.set(row.occurrenceId, list);
    }

    const activeRow = topics.find((topic) => topic.status === "active") ?? null;
    const activeTopic: ActiveTopicState | null = activeRow ? {
      topicId: activeRow.id,
      reviewKind: activeRow.reviewKind === "evening" || activeRow.reviewKind === "weekly" ? activeRow.reviewKind : null,
      clarificationCount: activeRow.clarificationCount,
      reviewState: activeRow.reviewKind === "weekly" ? parseWeeklyReviewState(activeRow.reviewState) : null,
      mode: activeRow.mode,
    } : null;
    const reviewKind = input.review ?? activeTopic?.reviewKind ?? null;
    const snapshot = reviewKind === "weekly"
      ? (await this.briefings.build({ workspaceId, kind: "weekly", localDate: localDateAt(now, input.timezone), timezone: input.timezone, now })).text
      : null;

    const composed = composeTurnContext({
      now,
      timezone: input.timezone,
      tasks: selection.shown,
      tasksTotal: selection.total,
      truncated: selection.truncated,
      occurrencesByTask: taskData.occurrencesByTask,
      checklistByTask,
      goals,
      taskGoalLinks,
      profile,
      memoryMatches,
      settings,
      topics,
      eventTypesByOccurrence,
      blockers,
      pendingProposal: input.pendingGroup ? { createdAt: input.pendingGroup.createdAt, titles: input.pendingGroup.titles } : null,
      focus: focusTaskId && input.focus ? { taskId: focusTaskId, action: input.focus.action } : null,
      review: reviewKind ? {
        kind: reviewKind,
        questionsAsked: activeTopic?.reviewKind === reviewKind ? activeTopic.clarificationCount : 0,
        ...(snapshot ? { snapshot } : {}),
        ...(reviewKind === "weekly" && activeTopic?.reviewState ? { state: activeTopic.reviewState } : {}),
      } : null,
    });

    return {
      model: budgetModelContext(composed.model),
      refs: composed.refs,
      activeTopic,
      // Existing rows may still carry mode=analysis; the chat layer no longer sets it from the model.
      modelMode: reviewKind === "weekly" || activeTopic?.mode === "analysis" ? "deep" : "default",
      meta: { tasksShown: selection.shown.length, tasksTotal: selection.total, truncated: selection.truncated },
    };
  }

  private taskIdOfOccurrence(occurrencesByTask: ReadonlyMap<string, ReadonlyArray<{ id: string; taskId: string }>>, occurrenceId: string): string | null {
    for (const occurrences of occurrencesByTask.values()) {
      const match = occurrences.find((occurrence) => occurrence.id === occurrenceId);
      if (match) return match.taskId;
    }
    return null;
  }
}
