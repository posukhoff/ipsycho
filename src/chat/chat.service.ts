import { Injectable } from "@nestjs/common";
import { BriefingContentService } from "../briefings/briefing-content.service.js";
import { ActionStateUncertainError, ActionsService } from "../actions/actions.service.js";
import { AiService } from "../ai/ai.service.js";
import type { AiMessage } from "../ai/ai-provider.js";
import { aiBurstAllowed } from "../core/ai-usage-policy.js";
import { reviewClarificationDecision, reviewCorrection, reviewPresentation, reviewQuestionLimit, type ReviewKind } from "../core/review-policy.js";
import { localDateAt } from "../core/timezone.js";
import { aiTimeContext } from "../core/ai-time-context.js";
import { formatLocalDateTime, formatOccurrenceSchedule, reminderAddsTimingInformation } from "../core/time-presentation.js";
import { renderAppliedReport } from "../core/applied-report.js";
import { detectConversationControl, isClearConversationRequest } from "../core/conversation-control.js";
import { canonicalizeTopicDirective } from "../core/context-policy.js";
import { ContextService } from "../context/context.service.js";
import { MessagesRepository } from "../messages/messages.repository.js";
import { TasksService } from "../tasks/tasks.service.js";
import { safeError, safeMessageMetadata } from "../observability/safe-error.js";
import { containsExplicitMutationRequest, isMixedTaskMutationRequest, validateMutationIntent, type ProposedActionDraft, type TaskBatchStepDraft } from "../core/ai-actions.js";
import { emptyWeeklyReviewState, groundWeeklyReviewProgress, questionForMissingWeeklyDimension, weeklyReviewLifecycle, type WeeklyReviewState } from "../core/weekly-review-state.js";

export type ChatProcessResult =
  | { kind: "consent_required"; provider: string; consentVersion: string }
  | { kind: "ai_suspended" }
  | { kind: "ai_unavailable" }
  | { kind: "rate_limited" }
  | { kind: "nothing_to_retry" }
  | { kind: "duplicate" }
  | {
      kind: "ok";
      text: string;
      /** Deterministic report of persisted changes; rendered after the model text and never truncated with it. */
      report?: string;
      appliedGroupId?: string;
      pendingGroupId?: string;
      appliedCount: number;
      pendingCount: number;
      /** Human descriptions of the actions waiting for confirmation, in order. */
      pendingTitles?: string[];
      warnings: string[];
      topicId?: string;
      checkpointTopicId?: string;
      review?: { kind: ReviewKind; step?: number; totalSteps?: number; completed: boolean };
      /** The acknowledgement itself must not re-create a just-cleared AI history. */
      skipAssistantHistory?: boolean;
    };

@Injectable()
export class ChatService {
  constructor(
    private readonly ai: AiService,
    private readonly actions: ActionsService,
    private readonly messages: MessagesRepository,
    private readonly tasks: TasksService,
    private readonly context: ContextService,
    private readonly briefings: BriefingContentService,
  ) {}

  get providerName(): string { return this.ai.providerName; }

  isAiConfigured(): boolean { return this.ai.isConfigured(); }

  async voiceGate(userId: string): Promise<"ready" | "consent" | "unavailable" | "rate_limited" | "suspended"> {
    if (!this.ai.isConfigured()) return "unavailable";
    if (!await this.messages.isAiProcessingAllowed(userId)) return "suspended";
    const [textConsent, voiceConsent] = await Promise.all([
      this.ai.hasConsent(userId),
      this.ai.hasProviderConsent(userId, "openai"),
    ]);
    if (!textConsent || !voiceConsent) return "consent";
    const since = new Date(Date.now() - 60 * 60_000);
    const [messages, calls] = await Promise.all([this.messages.countUserMessagesSince(userId, since), this.ai.callsLastHour(userId)]);
    return messages < this.ai.maxMessagesPerHour - 1 && calls < this.ai.maxCallsPerHour - 1 ? "ready" : "rate_limited";
  }

  async grantConsent(userId: string, _workspaceId?: string): Promise<void> {
    // Consent does not replay previously blocked text. The user must explicitly /retry_ai.
    await this.ai.grantConsent(userId);
  }

  async grantVoiceConsent(userId: string): Promise<void> {
    const providers = new Set([this.ai.providerName, "openai"]);
    await Promise.all([...providers].map((provider) => this.ai.grantProviderConsent(userId, provider)));
  }

  async revokeConsent(userId: string): Promise<void> {
    const providers = new Set([this.ai.providerName, "openai"]);
    await Promise.all([...providers].map((provider) => this.ai.revokeProviderConsent(userId, provider)));
  }

  async processText(input: {
    workspaceId: string;
    userId: string;
    aiStatus: "enabled" | "suspended";
    timezone: string;
    language?: string | null;
    text: string;
    telegramChatId: number;
    telegramMessageId: number;
    review?: "evening" | "weekly";
    reviewTopicId?: string;
  }): Promise<ChatProcessResult> {
    if (isClearConversationRequest(input.text)) {
      const count = await this.clearConversation(input.workspaceId, input.userId);
      return { kind: "ok", text: aiHistoryClearedText(input.language, count), appliedCount: 0, pendingCount: 0, warnings: [], skipAssistantHistory: true };
    }
    const baseMessage = {
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: "user" as const,
      content: input.text,
      telegramChatId: input.telegramChatId,
      telegramMessageId: input.telegramMessageId,
    };
    if (input.aiStatus !== "enabled") {
      const saved = await this.messages.saveOnce({ ...baseMessage, status: "waiting_ai" });
      if (!saved.inserted) return { kind: "duplicate" };
      return { kind: "ai_suspended" };
    }
    if (!this.ai.isConfigured()) {
      const saved = await this.messages.saveOnce({ ...baseMessage, status: "waiting_ai" });
      if (!saved.inserted) return { kind: "duplicate" };
      return { kind: "ai_unavailable" };
    }
    if (!await this.ai.hasConsent(input.userId)) {
      const saved = await this.messages.saveOnce({ ...baseMessage, status: "blocked_consent" });
      if (!saved.inserted) return { kind: "duplicate" };
      return { kind: "consent_required", provider: this.ai.providerName, consentVersion: this.ai.consentVersion };
    }

    const saved = await this.messages.saveOnce({ ...baseMessage, status: "processing" });
    if (!saved.message) throw new Error("failed to persist inbound message");
    if (!saved.inserted) return { kind: "duplicate" };
    const inbound = saved.message;
    if (!await this.withinAiLimits(input.userId)) {
      await this.messages.deferAiUntil(input.workspaceId, input.userId, inbound.id, new Date(Date.now() + 60 * 60_000));
      return { kind: "rate_limited" };
    }
    return this.processPersistedMessage({ workspaceId: input.workspaceId, userId: input.userId, timezone: input.timezone, ...(input.language !== undefined ? { language: input.language } : {}), ...(input.review ? { review: input.review } : {}), ...(input.reviewTopicId ? { reviewTopicId: input.reviewTopicId } : {}), inbound });
  }

  async startReview(input: {
    workspaceId: string;
    userId: string;
    aiStatus: "enabled" | "suspended";
    timezone: string;
    digestTimezone?: string;
    language?: string | null;
    kind: ReviewKind;
  }): Promise<ChatProcessResult> {
    if (input.aiStatus !== "enabled") return { kind: "ai_suspended" };
    if (!this.ai.isConfigured()) return { kind: "ai_unavailable" };
    if (!await this.ai.hasConsent(input.userId)) return { kind: "consent_required", provider: this.ai.providerName, consentVersion: this.ai.consentVersion };
    if (!await this.withinAiLimits(input.userId)) return { kind: "rate_limited" };

    const topic = input.kind === "evening"
      ? await this.context.beginEveningReview({ workspaceId: input.workspaceId, userId: input.userId })
      : await this.context.beginWeeklyReview({ workspaceId: input.workspaceId, userId: input.userId });
    try {
      const result = await this.processReviewStart({ ...input, topicId: topic.id });
      if (result.kind !== "ok") await this.context.resolveTopic(input.workspaceId, input.userId, topic.id).catch(() => undefined);
      return result;
    } catch (error) {
      await this.context.resolveTopic(input.workspaceId, input.userId, topic.id).catch(() => undefined);
      throw error;
    }
  }

  async startProfile(input: { workspaceId: string; userId: string }): Promise<ChatProcessResult> {
    const [topic, profile] = await Promise.all([
      this.context.beginProfile(input),
      this.context.profileOverview(input.workspaceId, input.userId),
    ]);
    const facts = profile.map((item) => `• ${item.content}`).join("\n");
    return {
      kind: "ok",
      text: [
        "🧭 Контекст пользователя",
        "",
        facts || "Пока здесь ничего нет.",
        "",
        "Можно отвечать свободно, пропускать вопросы или закончить в любой момент. Начнём с простого: какой у тебя обычно режим дня — когда встаёшь, ложишься и в какие часы лучше не планировать важное?",
      ].join("\n"),
      appliedCount: 0,
      pendingCount: 0,
      warnings: [],
      topicId: topic.id,
    };
  }

  async retryLatest(input: { workspaceId: string; userId: string; aiStatus: "enabled" | "suspended"; timezone: string; language?: string | null }): Promise<ChatProcessResult> {
    if (input.aiStatus !== "enabled") return { kind: "ai_suspended" };
    if (!this.ai.isConfigured()) return { kind: "ai_unavailable" };
    if (!await this.ai.hasConsent(input.userId)) return { kind: "consent_required", provider: this.ai.providerName, consentVersion: this.ai.consentVersion };
    const waiting = await this.messages.findLatestRetryable(input.workspaceId, input.userId);
    if (!waiting) return { kind: "nothing_to_retry" };
    return this.retryMessage({ workspaceId: input.workspaceId, userId: input.userId, timezone: input.timezone, ...(input.language !== undefined ? { language: input.language } : {}), messageId: waiting.id });
  }

  async retryMessage(input: { workspaceId: string; userId: string; timezone: string; language?: string | null; messageId: string }): Promise<ChatProcessResult> {
    if (!this.ai.isConfigured()) return { kind: "ai_unavailable" };
    if (!await this.ai.hasConsent(input.userId)) return { kind: "consent_required", provider: this.ai.providerName, consentVersion: this.ai.consentVersion };
    if (!await this.withinAiLimits(input.userId)) {
      await this.messages.deferAiUntil(input.workspaceId, input.userId, input.messageId, new Date(Date.now() + 60 * 60_000));
      return { kind: "rate_limited" };
    }
    const inbound = await this.messages.claimRetryable(input.workspaceId, input.userId, input.messageId);
    if (!inbound) return { kind: "nothing_to_retry" };
    return this.processPersistedMessage({ workspaceId: input.workspaceId, userId: input.userId, timezone: input.timezone, ...(input.language !== undefined ? { language: input.language } : {}), inbound });
  }

  async endConversation(workspaceId: string, userId: string, topicId?: string): Promise<boolean> {
    if (topicId) {
      const topic = await this.context.findTopic(workspaceId, userId, topicId);
      return topic ? this.context.resolveTopic(workspaceId, userId, topic.id) : false;
    }
    const context = await this.context.buildAiContext({ workspaceId, userId, query: "" });
    const active = context.topics.find((item) => item.status === "active");
    return active ? this.context.resolveTopic(workspaceId, userId, active.topicId) : false;
  }

  async concludeConversation(input: {
    workspaceId: string;
    userId: string;
    aiStatus: "enabled" | "suspended";
    timezone: string;
    language?: string | null;
    topicId?: string;
  }): Promise<ChatProcessResult> {
    const conversationContext = await this.context.buildAiContext({ workspaceId: input.workspaceId, userId: input.userId, query: "" });
    const topic = input.topicId
      ? conversationContext.topics.find((item) => item.topicId === input.topicId)
      : conversationContext.topics.find((item) => item.status === "active");
    if (!topic) return { kind: "ok", text: "Сейчас нет активного разбора, который нужно завершать.", appliedCount: 0, pendingCount: 0, warnings: [] };

    const fallback = topic.summary.trim() ? `Итог по уже сохранённому контексту: ${topic.summary.trim()}` : "Обсуждение завершено. Новых действий я не сохранял.";
    const finish = async (text: string): Promise<ChatProcessResult> => {
      await this.context.resolveTopic(input.workspaceId, input.userId, topic.topicId).catch(() => undefined);
      return {
        kind: "ok", text, appliedCount: 0, pendingCount: 0, warnings: [], topicId: topic.topicId,
        ...(topic.reviewKind === "evening" || topic.reviewKind === "weekly" ? { review: { kind: topic.reviewKind, completed: true } } : {}),
      };
    };

    if (input.aiStatus !== "enabled" || !this.ai.isConfigured() || !await this.ai.hasConsent(input.userId) || !await this.withinAiLimits(input.userId)) {
      return finish(fallback);
    }

    try {
      const [taskContext, historyRows] = await Promise.all([
        this.tasks.getAiContext(input.workspaceId),
        this.messages.listRecentForAi(input.workspaceId, input.userId, 20, topic.topicId),
      ]);
      const history: AiMessage[] = [
        ...historyRows.map((row) => ({ role: row.role, content: row.content })),
        { role: "user", content: "Сделай лучший возможный краткий вывод из уже известного и закончи обсуждение. Ничего нового не сохраняй и не задавай вопросов." },
      ];
      // Consent and account state can change while context is being built. Re-check at the provider boundary.
      if (!await this.messages.isAiProcessingAllowed(input.userId) || !await this.ai.hasConsent(input.userId)) return finish(fallback);
      const turn = await this.ai.respond({
        workspaceId: input.workspaceId,
        userId: input.userId,
        timezone: input.timezone,
        ...(input.language !== undefined ? { language: input.language } : {}),
        messages: history,
        domainContext: { actionableItems: taskContext, ...conversationContext },
        modelMode: topic.mode === "analysis" ? "deep" : "default",
        correction: "This is an explicit conclusion-only control. Return actions=[], question=null. Do not propose or persist any new task, goal, memory, reminder, reschedule or cancellation. Give a best-effort conclusion from known context only.",
        now: new Date(),
      });
      return finish(turn.reply.trim() || fallback);
    } catch {
      return finish(fallback);
    }
  }

  pauseConversation(workspaceId: string, userId: string): Promise<number> {
    return this.context.pauseActiveTopics(workspaceId, userId);
  }

  async clearConversation(workspaceId: string, userId: string): Promise<number> {
    await this.context.pauseActiveTopics(workspaceId, userId);
    return this.messages.clearConversation(workspaceId, userId);
  }

  historyMessageCount(workspaceId: string, userId: string): Promise<number> {
    return this.messages.countConversation(workspaceId, userId);
  }

  async recordAssistantMessage(input: {
    workspaceId: string; userId: string; content: string; telegramChatId: number; telegramMessageId: number; topicId?: string;
  }): Promise<void> {
    await this.messages.save({
      workspaceId: input.workspaceId, userId: input.userId, role: "assistant", content: input.content,
      ...(input.topicId ? { topicId: input.topicId } : {}), telegramChatId: input.telegramChatId, telegramMessageId: input.telegramMessageId,
    });
  }

  private async withinAiLimits(userId: string, now = new Date()): Promise<boolean> {
    const since = new Date(now.getTime() - 60 * 60_000);
    const [messagesLastHour, callsLastHour] = await Promise.all([
      this.messages.countUserMessagesSince(userId, since), this.ai.callsLastHour(userId, now),
    ]);
    return aiBurstAllowed({
      messagesLastHour, callsLastHour, maxMessagesPerHour: this.ai.maxMessagesPerHour, maxCallsPerHour: this.ai.maxCallsPerHour,
    });
  }

  private async processReviewStart(input: {
    workspaceId: string;
    userId: string;
    timezone: string;
    digestTimezone?: string;
    language?: string | null;
    kind: ReviewKind;
    topicId?: string;
  }): Promise<ChatProcessResult> {
    const initialGate = await this.currentAiAccessGate(input.userId);
    if (initialGate) return initialGate;

    const now = new Date();
    const conversationContext = await this.context.buildAiContext({ workspaceId: input.workspaceId, userId: input.userId, query: "" });
    let domainContext: unknown;
    let messages: AiMessage[];
    let modelMode: "default" | "deep";

    if (input.kind === "weekly") {
      const digestTimezone = input.digestTimezone ?? input.timezone;
      const snapshot = await this.briefings.build({
        workspaceId: input.workspaceId,
        kind: "weekly",
        localDate: localDateAt(now, digestTimezone),
        timezone: digestTimezone,
        now,
      });
      domainContext = { WEEKLY_REVIEW_SNAPSHOT: snapshot.text, goals: conversationContext.goals };
      messages = [{ role: "user", content: "Начни совместное планирование следующей недели по этому обзору. Сначала кратко назови главные незавершённые или рискованные пункты и задай один вопрос о приоритетах. Ничего не меняй без моего явного выбора." }];
      modelMode = "deep";
    } else {
      const taskContext = await this.tasks.getAiContext(input.workspaceId);
      domainContext = { actionableItems: taskContext, ...conversationContext };
      messages = [{ role: "user", content: "Начни вечерний обзор по текущим незавершённым делам." }];
      modelMode = "default";
    }

    const providerGate = await this.currentAiAccessGate(input.userId);
    if (providerGate) return providerGate;

    let turn = await this.ai.respond({
      workspaceId: input.workspaceId,
      userId: input.userId,
      timezone: input.timezone,
      ...(input.language !== undefined ? { language: input.language } : {}),
      messages,
      domainContext,
      modelMode,
      correction: `${reviewCorrection(input.kind)}${input.kind === "weekly" ? " This is the opening turn: return actions=[] and ask one planning question." : ""}`,
      now,
    });
    turn = normalizeReviewTurn(turn, input.kind);

    const scope = { workspaceId: input.workspaceId, actorUserId: input.userId, recipientUserId: input.userId, now };
    let validationErrors = await this.actions.validate(turn.actions, scope);
    if (validationErrors.length) {
      const repairGate = await this.currentAiAccessGate(input.userId);
      if (repairGate) return repairGate;
      turn = await this.ai.respond({
        workspaceId: input.workspaceId,
        userId: input.userId,
        timezone: input.timezone,
        ...(input.language !== undefined ? { language: input.language } : {}),
        messages,
        domainContext,
        modelMode,
        correction: `${reviewCorrection(input.kind)} The previous action draft violated domain rules: ${validationErrors.join(" | ")}. Re-derive safely from CURRENT_CONTEXT.`,
        now,
      });
      turn = normalizeReviewTurn(turn, input.kind);
      validationErrors = await this.actions.validate(turn.actions, scope);
      if (validationErrors.length) {
        if (input.topicId) await this.context.resolveTopic(input.workspaceId, input.userId, input.topicId, now).catch(() => undefined);
        return { kind: "ok", text: "Не смог безопасно собрать обзор. Попробуй ещё раз позже.", appliedCount: 0, pendingCount: 0, warnings: [] };
      }
    }

    const actionResult = await this.actions.handleProposed(turn.actions, scope);
    let checkpoint = false;
    let reviewUi: { kind: ReviewKind; step?: number; totalSteps?: number; completed: boolean } | undefined;
    if (input.topicId) {
      const askedQuestion = Boolean(turn.question?.trim());
      const decision = reviewClarificationDecision({ kind: input.kind, clarificationCountBeforeTurn: 0, askedQuestion });
      await this.context.updateClarificationCount({ workspaceId: input.workspaceId, userId: input.userId, topicId: input.topicId, askedQuestion, now }).catch(() => 0);
      checkpoint = decision.checkpoint;
      reviewUi = reviewPresentation({ kind: input.kind, clarificationCountBeforeTurn: 0, askedQuestion });
      if (decision.resolveAfterTurn) await this.context.resolveTopic(input.workspaceId, input.userId, input.topicId, now).catch(() => undefined);
    }

    const reviewReport = appliedReportText(turn.actions, actionResult.applied, now);
    return {
      kind: "ok",
      text: renderTurn(turn.reply, turn.question),
      ...(reviewReport ? { report: reviewReport } : {}),
      ...(actionResult.applied ? { appliedGroupId: actionResult.applied.groupId } : {}),
      ...(actionResult.pending ? { pendingGroupId: actionResult.pending.groupId, pendingTitles: actionResult.pending.titles } : {}),
      appliedCount: actionResult.applied?.count ?? 0,
      pendingCount: actionResult.pending?.count ?? 0,
      warnings: actionResult.warnings ?? [],
      ...(input.topicId ? { topicId: input.topicId } : {}),
      ...(checkpoint && input.topicId ? { checkpointTopicId: input.topicId } : {}),
      ...(reviewUi ? { review: reviewUi } : {}),
    };
  }

  private async processPersistedMessage(input: {
    workspaceId: string; userId: string; timezone: string; language?: string | null; review?: "evening" | "weekly"; reviewTopicId?: string; inbound: { id: string; content: string };
  }): Promise<ChatProcessResult> {
    try {
      // Re-check after persistence: user/AI status and provider consent can change while the
      // Telegram handler is running. Never rely only on the earlier handler snapshot.
      const initialGate = await this.currentAiGate(input.workspaceId, input.userId, input.inbound.id);
      if (initialGate) return initialGate;
      const turnNow = new Date();
      if (!this.actions.isTaskBatchEnabled() && isMixedTaskMutationRequest(input.inbound.content)) {
        await this.messages.setStatus(input.workspaceId, input.inbound.id, "processed");
        return { kind: "ok", text: disabledTaskBatchReply(input.language, input.inbound.content), appliedCount: 0, pendingCount: 0, warnings: [] };
      }
      const [taskContext, conversationContext] = await Promise.all([
        this.tasks.getAiContext(input.workspaceId),
        this.context.buildAiContext({ workspaceId: input.workspaceId, userId: input.userId, query: input.inbound.content, now: turnNow }),
      ]);
      const activeTopic = conversationContext.topics.find((item) => item.status === "active");
      const currentTopicId = input.reviewTopicId ?? activeTopic?.topicId;
      const review = input.review ?? (activeTopic?.reviewKind === "evening" || activeTopic?.reviewKind === "weekly" ? activeTopic.reviewKind : undefined);
      const clarificationCountBeforeTurn = currentTopicId
        ? conversationContext.topics.find((item) => item.topicId === currentTopicId)?.clarificationCount ?? 0
        : 0;
      const forceReviewConclusion = review
        ? reviewClarificationDecision({ kind: review, clarificationCountBeforeTurn, askedQuestion: false }).forceConclusion
        : false;
      const historyRows = await this.messages.listRecentForAi(input.workspaceId, input.userId, 19, currentTopicId);
      const history: AiMessage[] = [
        ...historyRows.map((row) => ({ role: row.role, content: row.content })),
        { role: "user", content: input.inbound.content },
      ];
      const scope = { workspaceId: input.workspaceId, actorUserId: input.userId, recipientUserId: input.userId, now: turnNow };
      let domainContext: unknown = { actionableItems: taskContext, ...conversationContext };
      let modelMode = conversationContext.modelMode;
      if (review === "weekly") {
        const snapshot = await this.briefings.build({
          workspaceId: input.workspaceId,
          kind: "weekly",
          localDate: localDateAt(scope.now, input.timezone),
          timezone: input.timezone,
          now: scope.now,
        });
        domainContext = { ...(domainContext as object), WEEKLY_REVIEW_SNAPSHOT: snapshot.text };
        modelMode = "deep";
      }
      const control = detectConversationControl(input.inbound.content);

      const providerGate = await this.currentAiGate(input.workspaceId, input.userId, input.inbound.id);
      if (providerGate) return providerGate;
      let turn = await this.ai.respond({
        workspaceId: input.workspaceId,
        userId: input.userId,
        timezone: input.timezone,
        ...(input.language !== undefined ? { language: input.language } : {}),
        messages: history,
        domainContext,
        modelMode,
        ...(review ? { correction: reviewCorrection(review, forceReviewConclusion) } : control === "no_persist" ? { correction: "The user explicitly said not to save anything from this turn. Return actions=[]; ordinary conversational reply is allowed." } : {}),
        now: scope.now,
      });
      turn = canonicalizeTurnTopic(normalizeReviewTurn(turn, review, forceReviewConclusion), currentTopicId);
      if (control === "no_persist") turn = { ...turn, actions: [] };
      if (review && currentTopicId) {
        turn = { ...turn, topic: pinReviewTopic(turn.topic, currentTopicId, input.inbound.content, review) };
      }
      if (review === "weekly") turn = { ...turn, actions: normalizeWeeklyReviewActions(turn.actions as ProposedActionDraft[], input.inbound.content, this.actions.isTaskBatchEnabled()) as unknown as typeof turn.actions };
      let validationErrors = await this.actions.validate(turn.actions, scope);
      const goalFocusError = validateGoalFocusTurn(turn, conversationContext);
      if (goalFocusError) validationErrors.push(goalFocusError);
      const previousAssistantText = [...history].reverse().find((message) => message.role === "assistant")?.content;
      const mutationIntentError = validateMutationIntent(turn.actions, input.inbound.content, previousAssistantText);
      if (mutationIntentError) validationErrors.push(mutationIntentError);
      const topicError = control === "no_persist" ? null : await this.context.validateTopicDirective({ workspaceId: input.workspaceId, userId: input.userId, directive: turn.topic });
      if (topicError) validationErrors.push(`topic: ${topicError}`);
      const retryActionlessBatch = shouldRetryActionlessTaskBatch(turn.actions, input.inbound.content, this.actions.isTaskBatchEnabled());
      if (validationErrors.length || retryActionlessBatch) {
        const repairErrors = [
          ...validationErrors,
          ...(retryActionlessBatch ? ["an explicit grouped task request returned no action; use the unique listed targets and already supplied times without asking for confirmation again"] : []),
        ];
        const firstAttempt = describeRejectedTurn(turn, repairErrors.map(sanitizedValidationReason));
        const repairGate = await this.currentAiGate(input.workspaceId, input.userId, input.inbound.id);
        if (repairGate) return repairGate;
        turn = await this.ai.respond({
          workspaceId: input.workspaceId, userId: input.userId, timezone: input.timezone, ...(input.language !== undefined ? { language: input.language } : {}), messages: history, domainContext, modelMode,
          correction: `${review ? `${reviewCorrection(review, forceReviewConclusion)} ` : ""}The previous action draft violated domain rules: ${repairErrors.join(" | ")}. Re-derive it from the user's message and CURRENT_CONTEXT. Do not ask the user to reconfirm a target, scope, timezone, or time already uniquely supplied in the message and CURRENT_CONTEXT. If material information is genuinely missing, ask one clarification question and return no action.`,
          now: scope.now,
        });
        turn = canonicalizeTurnTopic(normalizeReviewTurn(turn, review, forceReviewConclusion), currentTopicId);
        if (control === "no_persist") turn = { ...turn, actions: [] };
        if (review && currentTopicId) {
          turn = { ...turn, topic: pinReviewTopic(turn.topic, currentTopicId, input.inbound.content, review) };
        }
        if (review === "weekly") turn = { ...turn, actions: normalizeWeeklyReviewActions(turn.actions as ProposedActionDraft[], input.inbound.content, this.actions.isTaskBatchEnabled()) as unknown as typeof turn.actions };
        validationErrors = await this.actions.validate(turn.actions, scope);
        const repairedGoalFocusError = validateGoalFocusTurn(turn, conversationContext);
        if (repairedGoalFocusError) validationErrors.push(repairedGoalFocusError);
        const repairedMutationIntentError = validateMutationIntent(turn.actions, input.inbound.content, previousAssistantText);
        if (repairedMutationIntentError) validationErrors.push(repairedMutationIntentError);
        const repairedTopicError = control === "no_persist" ? null : await this.context.validateTopicDirective({ workspaceId: input.workspaceId, userId: input.userId, directive: turn.topic });
        if (repairedTopicError) validationErrors.push(`topic: ${repairedTopicError}`);
        if (validationErrors.length) {
          const goalClarification = validationErrors.some((error) => /goalAnalysisFocus|goal analysis/i.test(error))
            ? deterministicGoalClarification(conversationContext, input.language)
            : null;
          if (goalClarification) {
            await this.messages.setStatus(input.workspaceId, input.inbound.id, "processed");
            return { kind: "ok", text: goalClarification, appliedCount: 0, pendingCount: 0, warnings: [] };
          }
          console.warn("AI action rejected after structured repair\n" + JSON.stringify({
            conversation: history.map((message) => ({ role: message.role, ...safeMessageMetadata(message.content) })),
            currentContext: safeContextMetadata(domainContext),
            timeContext: aiTimeContext(scope.now, input.timezone),
            firstAttempt,
            repairedAttempt: describeRejectedTurn(turn, validationErrors.map(sanitizedValidationReason)),
          }, null, 2));
          await this.messages.setStatus(input.workspaceId, input.inbound.id, "processed");
          return { kind: "ok", text: renderTurn(rejectedActionReply(validationErrors), null), appliedCount: 0, pendingCount: 0, warnings: [] };
        }
        console.info("AI structured repair completed", { outcome: "accepted", reasonCodes: firstAttempt.errors });
      }

      let weeklyState: WeeklyReviewState | null = null;
      if (review === "weekly" && currentTopicId) {
        weeklyState = await this.context.mergeWeeklyReviewProgress({
          workspaceId: input.workspaceId, userId: input.userId, topicId: currentTopicId,
          progress: groundWeeklyReviewProgress(turn.reviewProgress, input.inbound.content), now: scope.now,
        }).catch(() => conversationContext.topics.find((item) => item.topicId === currentTopicId)?.reviewState ?? emptyWeeklyReviewState());
        console.info("weekly review progress", {
          topicId: currentTopicId,
          providedCount: [weeklyState.outcome, weeklyState.capacityEnergy, weeklyState.risks, weeklyState.minimumSuccess, weeklyState.commitments].filter(Boolean).length,
          clarificationCount: clarificationCountBeforeTurn,
        });
        const lifecycle = weeklyReviewLifecycle(weeklyState, clarificationCountBeforeTurn);
        if (lifecycle.complete) {
          turn = { ...turn, question: null, reply: lifecycle.assumptionsRequired ? ensureAssumptionsLabel(turn.reply) : removeDanglingContinuation(turn.reply) };
        } else if (!turn.question?.trim()) {
          turn = { ...turn, question: questionForMissingWeeklyDimension(weeklyState) };
        }
        turn = { ...turn, actions: normalizeWeeklyReviewActions(turn.actions as ProposedActionDraft[], input.inbound.content, this.actions.isTaskBatchEnabled()) as unknown as typeof turn.actions };
      }
      const actionResult = await this.actions.handleProposed(turn.actions, { ...scope, sourceMessageId: input.inbound.id });
      if (!review && turn.profileInvitation) {
        await this.context.markProfileInvitationShown(input.userId, scope.now).catch((error) => {
          console.error("profile invitation state update failed", { messageId: input.inbound.id, message: safeMessageMetadata(input.inbound.content), error: safeError(error) });
        });
      }
      let topicId: string | null = control === "no_persist" ? currentTopicId ?? null : null;
      if (control !== "no_persist") {
        try {
          topicId = await this.context.applyTopicDirective({
            workspaceId: input.workspaceId, userId: input.userId, messageId: input.inbound.id, directive: turn.topic,
            modeSuggestion: turn.topicModeSuggestion, now: scope.now,
          });
        } catch (error) {
          console.error("topic update failed after successful turn", { messageId: input.inbound.id, message: safeMessageMetadata(input.inbound.content), error: safeError(error) });
        }
      }
      await this.messages.setStatus(input.workspaceId, input.inbound.id, "processed").catch((error) => {
        console.error("message status update failed after successful turn", { messageId: input.inbound.id, message: safeMessageMetadata(input.inbound.content), error: safeError(error) });
      });
      let checkpoint = false;
      let reviewUi: { kind: ReviewKind; step?: number; totalSteps?: number; completed: boolean } | undefined;
      if (topicId && control !== "no_persist") {
        const askedQuestion = Boolean(turn.question?.trim());
        const count = await this.context.updateClarificationCount({
          workspaceId: input.workspaceId, userId: input.userId, topicId, askedQuestion, now: scope.now,
        }).catch(() => clarificationCountBeforeTurn);
        if (review) {
          if (review === "weekly" && weeklyState) {
            const lifecycle = weeklyReviewLifecycle(weeklyState, clarificationCountBeforeTurn);
            const totalSteps = reviewQuestionLimit("weekly");
            checkpoint = !lifecycle.complete && askedQuestion && clarificationCountBeforeTurn + 1 >= totalSteps;
            reviewUi = { kind: "weekly", ...(askedQuestion ? { step: Math.min(totalSteps, clarificationCountBeforeTurn + 1), totalSteps } : {}), completed: lifecycle.complete };
            if (lifecycle.complete) await this.context.resolveTopic(input.workspaceId, input.userId, topicId, scope.now).catch(() => undefined);
          } else {
            const decision = reviewClarificationDecision({ kind: review, clarificationCountBeforeTurn, askedQuestion });
            checkpoint = decision.checkpoint;
            reviewUi = reviewPresentation({ kind: review, clarificationCountBeforeTurn, askedQuestion });
            if (decision.resolveAfterTurn) await this.context.resolveTopic(input.workspaceId, input.userId, topicId, scope.now).catch(() => undefined);
          }
        } else if (askedQuestion && count >= 5) {
          checkpoint = true;
          await this.context.resetClarificationCount(input.workspaceId, input.userId, topicId, scope.now).catch(() => undefined);
        }
      }
      const report = appliedReportText(turn.actions, actionResult.applied, scope.now);
      return {
        kind: "ok",
        text: renderTurn(turn.reply, turn.question),
        ...(report ? { report } : {}),
        ...(actionResult.applied && actionResult.applied.undoable !== false ? { appliedGroupId: actionResult.applied.groupId } : {}),
        ...(actionResult.pending ? { pendingGroupId: actionResult.pending.groupId, pendingTitles: actionResult.pending.titles } : {}),
        appliedCount: actionResult.applied?.count ?? 0,
        pendingCount: actionResult.pending?.count ?? 0,
        warnings: actionResult.warnings ?? [],
        ...(topicId ? { topicId } : {}),
        ...(checkpoint && topicId ? { checkpointTopicId: topicId } : {}),
        ...(reviewUi ? { review: reviewUi } : {}),
      };
    } catch (error) {
      if (error instanceof ActionStateUncertainError) {
        await this.messages.setStatus(input.workspaceId, input.inbound.id, "processed").catch(() => undefined);
      } else {
        await this.messages.scheduleAiRetry(input.workspaceId, input.userId, input.inbound.id).catch(() => undefined);
      }
      throw error;
    }
  }

  private async currentAiAccessGate(userId: string): Promise<ChatProcessResult | null> {
    if (!this.ai.isConfigured()) return { kind: "ai_unavailable" };
    if (!await this.messages.isAiProcessingAllowed(userId)) return { kind: "ai_suspended" };
    if (!await this.ai.hasConsent(userId)) return { kind: "consent_required", provider: this.ai.providerName, consentVersion: this.ai.consentVersion };
    return null;
  }

  private async currentAiGate(workspaceId: string, userId: string, messageId: string): Promise<ChatProcessResult | null> {
    const gate = await this.currentAiAccessGate(userId);
    if (!gate) return null;
    await this.messages.setStatus(workspaceId, messageId, gate.kind === "consent_required" ? "blocked_consent" : "waiting_ai");
    return gate;
  }
}

function aiHistoryClearedText(language: string | null | undefined, count: number): string {
  if (language?.toLowerCase().startsWith("uk")) return `AI-історію очищено (${count} повідомлень). Повідомлення Telegram, завдання, цілі, нагадування й налаштування не змінені.`;
  if (language?.toLowerCase().startsWith("en")) return `AI history cleared (${count} messages). Telegram messages, tasks, goals, reminders, and settings are unchanged.`;
  return `AI-история очищена (${count} сообщений). Сообщения Telegram, задачи, цели, напоминания и настройки не изменены.`;
}

function describeRejectedTurn(turn: { reply: string; question: string | null; actions: ProposedActionDraft[]; topic: { mode: string; topicId: string | null; title: string | null; summary: string | null } }, errors: readonly string[]) {
  return {
    errors: [...errors],
    reply: safeMessageMetadata(turn.reply),
    question: turn.question ? safeMessageMetadata(turn.question) : null,
    actionTypes: turn.actions.map((action) => action.type),
    temporalFields: turn.actions.flatMap<{ action: number; type: string; fields: Record<string, unknown> }>((action, index) => {
      if (action.type === "create_task") return [{ action: index + 1, type: action.type, fields: {
        plannedStartAt: action.definition.plannedStartAt, plannedEndAt: action.definition.plannedEndAt,
        plannedLocalDate: action.definition.plannedLocalDate, dueAt: action.definition.dueAt,
        dueLocalDate: action.definition.dueLocalDate, reviewAt: action.definition.reviewAt, timezone: action.definition.timezone,
      } }];
      if (action.type === "reschedule_occurrence") return [{ action: index + 1, type: action.type, fields: action.schedule }];
      if (action.type === "change_reminder" && action.reminder?.exactAt) {
        return [{ action: index + 1, type: action.type, fields: { reminderExactAt: action.reminder.exactAt } }];
      }
      if (action.type === "change_series" && action.edit) return [{ action: index + 1, type: action.type, fields: {
        plannedStartAt: action.edit.plannedStartAt, plannedEndAt: action.edit.plannedEndAt,
        plannedLocalDate: action.edit.plannedLocalDate, dueAt: action.edit.dueAt,
        dueLocalDate: action.edit.dueLocalDate, timezone: action.edit.timezone,
      } }];
      return [];
    }),
    topic: { mode: turn.topic.mode, hasTopicId: Boolean(turn.topic.topicId) },
  };
}

/** A rejection log explains the failed shape without duplicating personal context. */
function safeContextMetadata(context: unknown): { kind: string; keys?: string[]; arrayLength?: number } {
  if (Array.isArray(context)) return { kind: "array", arrayLength: context.length };
  if (context && typeof context === "object") return { kind: "object", keys: Object.keys(context).sort() };
  return { kind: typeof context };
}

function rejectedActionReply(errors: readonly string[]): string {
  if (errors.some((error) => /must not be in the past|must not be before today|reminder must be in the future/.test(error))) {
    return "Выбранная точка даёт время в прошлом, поэтому я ничего не изменил. Скажи, считать от текущего момента или укажи новую дату и время.";
  }
  if (errors.some((error) => /task_batch|batch step|step \d+/i.test(error))) {
    return "Пакет задач не применён: один из шагов оказался неоднозначным или устарел. Ничего из пакета не изменено — уточни спорный шаг одним сообщением.";
  }
  return "Я понял сообщение, но не смог безопасно определить действие. Уточни задачу или время одним сообщением.";
}

function sanitizedValidationReason(error: string): string {
  if (/task_batch rollout is disabled/i.test(error)) return "task_batch_disabled";
  if (/^topic:/i.test(error)) return "invalid_topic_directive";
  if (/goalAnalysisFocus|goal analysis/i.test(error)) return "invalid_goal_focus";
  if (/informational question|mutation request|AI-inferred proposal|explicit user request or acceptance/i.test(error)) return "mutation_intent_mismatch";
  if (/missing or stale|version|stale/i.test(error)) return "stale_reference";
  if (/duplicate|already linked|unique/i.test(error)) return "duplicate_reference";
  if (/past|before today|future/i.test(error)) return "invalid_time";
  if (/task_batch|batch step|step /i.test(error)) return "invalid_batch_step";
  return "invalid_action";
}

/**
 * Deterministic confirmation built from persisted results, not from the model's prose.
 * The model may promise "напомню в 17:30" or say "Готово" about the wrong task; this block
 * shows what was actually stored so the user can catch a mismatch immediately.
 */
export function appendAppliedTiming(
  text: string,
  actions: readonly ProposedActionDraft[],
  applied?: NonNullable<import("../actions/actions.service.js").ProposedActionsResult["applied"]>,
  now: Date = new Date(),
): string {
  const report = appliedReportText(actions, applied, now);
  return report ? `${text}\n\n${report}` : text;
}

export function appliedReportText(
  actions: readonly ProposedActionDraft[],
  applied?: NonNullable<import("../actions/actions.service.js").ProposedActionsResult["applied"]>,
  now: Date = new Date(),
): string | undefined {
  if (!applied) return undefined;
  if (applied.items?.length) return renderAppliedReport(applied.items, now) || undefined;
  // Legacy results without report items (e.g. memory batches): keep the minimal timing facts.
  const details: string[] = [];
  for (const title of applied.linkedGoalTitles ?? []) details.push(`🎯 Связано с целью: ${title}`);
  const occurrence = applied.occurrenceSchedule;
  if (occurrence) {
    const detail = formatOccurrenceSchedule(occurrence, "ru-RU", now);
    if (detail) details.push(detail);
  }
  if (applied.scheduledReminderAt && (!occurrence || reminderAddsTimingInformation(occurrence, applied.scheduledReminderAt))) {
    const timezone = actions.find((action): action is Extract<ProposedActionDraft, { type: "create_task" }> => action.type === "create_task")?.definition.timezone ?? occurrence?.timezone;
    if (timezone) details.push(`🔔 Напоминание: ${formatLocalDateTime(applied.scheduledReminderAt, timezone, now)} (${timezone})`);
  }
  return details.length ? details.join("\n") : undefined;
}

export function normalizeReviewTurn<T extends { actions: readonly import("../core/ai-actions.js").ProposedActionDraft[]; question: string | null }>(turn: T, review?: ReviewKind, forceConclusion = false): T {
  let normalized = turn;
  const initialReply = (turn as T & { reply?: string }).reply;
  const question = turn.question?.trim();
  if (initialReply && question) {
    const escapedQuestion = question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const duplicate = new RegExp(`(?:\\*\\*|__)?${escapedQuestion}(?:\\*\\*|__)?\\s*$`, "u");
    if (duplicate.test(initialReply)) normalized = { ...turn, reply: initialReply.replace(duplicate, "").trimEnd() } as T;
  }
  if (review === "weekly" && forceConclusion) return { ...normalized, actions: [], question: null };
  if (review === "weekly" && !normalized.question) {
    const reply = (normalized as T & { reply?: string }).reply;
    const match = reply?.match(/(?:^|\n)([^\n?]{3,}\?)\s*$/u);
    if (match?.[1]) return { ...normalized, ...(reply ? { reply: reply.slice(0, match.index).trim() } : {}), question: match[1].trim() };
  }
  if (review === "evening") return { ...normalized, actions: normalized.actions.map((action) => ({ ...action, source: "ai_inferred" as const })), ...(forceConclusion ? { question: null } : {}) };
  return normalized;
}

export function normalizeWeeklyReviewActions(actions: readonly ProposedActionDraft[], userText: string, taskBatchEnabled = true): ProposedActionDraft[] {
  const explicitTaskChange = /(?:создай|добавь|запланируй|перенеси|измени|свяжи|створи|додай|заплануй|перенеси|зміни|зв.?яжи|create|add|schedule|reschedule|change|link)/iu.test(userText);
  const explicitMemory = /(?:запомни|сохрани\s+(?:это|как)|запам.?ятай|remember|save\s+this)/iu.test(userText);
  if (!explicitTaskChange) return explicitMemory ? actions.filter((action) => action.type === "save_memory") : [];
  const supported = actions.filter((action) => ["create_task", "update_task", "reschedule_occurrence", "link_task_to_goal", "task_batch"].includes(action.type));
  if (!taskBatchEnabled) {
    if (supported.some((action) => action.type === "task_batch")) return [];
    return [...supported];
  }
  if (supported.length === 1 && supported[0]?.type === "task_batch") return [supported[0]];
  if (!supported.length || supported.some((action) => action.type === "task_batch")) return [];
  const steps: TaskBatchStepDraft[] = [];
  for (const [index, action] of supported.entries()) {
    const stepId = `weekly_${index + 1}`;
    if (action.type === "create_task") {
      const { type: _type, ...draft } = action;
      steps.push({ ...draft, operation: "create", stepId });
    } else if (action.type === "update_task") {
      const { type: _type, taskId: _taskId, expectedVersion: _expectedVersion, ...draft } = action;
      steps.push({
      ...draft, operation: "update", stepId,
      target: { kind: "persisted" as const, taskId: action.taskId, expectedTaskVersion: action.expectedVersion },
      });
    } else if (action.type === "reschedule_occurrence") {
      const { type: _type, ...draft } = action;
      steps.push({ ...draft, operation: "reschedule", stepId });
    } else if (action.type === "link_task_to_goal") {
      const { type: _type, taskId: _taskId, expectedTaskVersion: _expectedTaskVersion, ...draft } = action;
      steps.push({
      ...draft, operation: "link_goal", stepId,
      target: { kind: "persisted" as const, taskId: action.taskId, expectedTaskVersion: action.expectedTaskVersion },
      });
    }
  }
  return [{
    type: "task_batch", source: steps.every((step) => step.source === "user_explicit") ? "user_explicit" : "ai_inferred",
    confidence: Math.min(...steps.map((step) => step.confidence)), steps,
  }];
}

function ensureAssumptionsLabel(reply: string): string {
  const cleaned = removeDanglingContinuation(reply);
  return /предполож|assum|припущ/iu.test(cleaned) ? cleaned : `${cleaned}\n\nДопущения: недостающие ограничения оценены по текущему контексту и требуют проверки.`;
}

export function removeDanglingContinuation(reply: string): string {
  return reply.replace(/(?:\s|\n)*(?:если хочешь|if you want|якщо хочеш)[\s\S]*$/iu, "").trim();
}

export function disabledTaskBatchReply(language: string | null | undefined, latestUserText: string): string {
  const locale = language?.toLocaleLowerCase() ?? "";
  const ukrainian = locale.startsWith("uk") || /(?:\b(?:будь\s+ласка|завдання|зустріч|перенеси|додай|прив'яжи|прив’яжи)\b|[іїєґ])/iu.test(latestUserText);
  if (locale.startsWith("en")) {
    return "This request combines several related task changes. Atomic task packages are currently disabled, so I made no changes. I can handle the operations one at a time, starting with the main priority, but they will not be one atomic change.";
  }
  if (ukrainian) {
    return "У цьому запиті поєднано кілька пов’язаних змін завдань. Атомарні пакети зараз вимкнені, тому я нічого не змінив. Можу виконати операції по одній, починаючи з головного пріоритету, але це не буде однією атомарною зміною.";
  }
  return "В этом запросе несколько связанных изменений задач. Атомарные пакеты сейчас выключены, поэтому я ничего не изменил. Могу выполнить операции по одной, начиная с главного приоритета, но это не будет одним атомарным изменением.";
}

export function shouldRetryActionlessTaskBatch(actions: readonly ProposedActionDraft[], latestUserText: string, taskBatchEnabled: boolean): boolean {
  if (!taskBatchEnabled || actions.length > 0) return false;
  const text = latestUserText.trim().toLocaleLowerCase();
  const grouped = /(?:пакет|разом|одним\s+(?:пакетом|набором)|in\s+one\s+batch|together\s+as\s+one)/u.test(text);
  return grouped && containsExplicitMutationRequest(text);
}

export function deterministicGoalClarification(context: unknown, language?: string | null): string | null {
  if (!context || typeof context !== "object") return null;
  const resolution = (context as { goalResolution?: unknown }).goalResolution;
  if (!resolution || typeof resolution !== "object") return null;
  const value = resolution as { state?: unknown; candidates?: unknown };
  if (value.state !== "ambiguous" || !Array.isArray(value.candidates)) return null;
  const titles = value.candidates
    .map((candidate) => candidate && typeof candidate === "object" ? (candidate as { title?: unknown }).title : null)
    .filter((title): title is string => typeof title === "string" && title.trim().length > 0)
    .map((title) => `«${title.trim().replace(/[«»]/g, "")}»`)
    .slice(0, 5);
  if (titles.length < 2) return null;
  const locale = language?.toLocaleLowerCase() ?? "";
  if (locale.startsWith("uk")) return `Бачу кілька відповідних цілей: ${titles.join(", ")}. Яку одну ціль розбираємо?`;
  if (locale.startsWith("en")) return `I see several possible goals: ${titles.join(", ")}. Which one should we analyze?`;
  return `Вижу несколько подходящих целей: ${titles.join(", ")}. Какую одну цель разбираем?`;
}

function canonicalizeTurnTopic<T extends { topic: import("../core/context-policy.js").TopicDirective }>(turn: T, currentTopicId?: string): T {
  let topic = canonicalizeTopicDirective(turn.topic);
  if (["continue", "resolve"].includes(topic.mode) && !topic.topicId) {
    topic = currentTopicId
      ? { ...topic, topicId: currentTopicId }
      : { ...topic, mode: "none", topicId: null, title: null, summary: null };
  }
  return { ...turn, topic };
}

function pinReviewTopic<T extends { mode: string; topicId: string | null; title: string | null; summary: string | null }>(directive: T, topicId: string, content: string, kind: ReviewKind): T {
  return {
    ...directive,
    mode: "continue",
    topicId,
    title: null,
    summary: directive.summary?.trim() || `${kind === "weekly" ? "Планирование недели" : "Вечерний разбор"}: ${content.trim().slice(0, 500)}`,
  };
}

export function validateGoalFocusTurn(
  turn: { goalAnalysisFocus?: { goalId: string; expectedVersion: number } | null; question: string | null; actions: readonly unknown[] },
  context: { goals: Array<{ goalId: string; goalVersion: number }>; goalResolution: { requested: boolean; state: "none" | "selected" | "ambiguous"; selected?: { goalId: string; goalVersion: number }; candidates: Array<{ goalId: string }> } },
): string | null {
  const focus = turn.goalAnalysisFocus ?? null;
  if (focus) {
    const owned = context.goals.find((goal) => goal.goalId === focus.goalId && goal.goalVersion === focus.expectedVersion);
    if (!owned) return "goalAnalysisFocus is missing, stale, or outside the current workspace";
    if (context.goalResolution.selected && (focus.goalId !== context.goalResolution.selected.goalId || focus.expectedVersion !== context.goalResolution.selected.goalVersion)) {
      return "goalAnalysisFocus does not match the deterministically selected goal";
    }
  }
  if (!context.goalResolution.requested) return null;
  if (context.goalResolution.state === "ambiguous") {
    if (focus || turn.actions.length) return "ambiguous goal analysis must ask for focus and perform no action";
    if (!turn.question?.trim()) return "ambiguous goal analysis requires one focused clarification question";
    return null;
  }
  if (context.goalResolution.state === "selected" && !focus && turn.actions.length === 0) return "selected persisted goal analysis requires goalAnalysisFocus";
  return null;
}

function renderTurn(reply: string, question: string | null): string {
  const trimmed = reply.trim();
  const q = question?.trim() ?? "";
  const base = q && !normalizedText(trimmed).includes(normalizedText(q)) ? `${trimmed}\n\n${q}` : trimmed;
  return base;
}

function normalizedText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[«»'"`.,!?;:—–-]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
