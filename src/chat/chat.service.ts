import { Injectable } from "@nestjs/common";
import { BriefingContentService } from "../briefings/briefing-content.service.js";
import { ActionStateUncertainError, ActionsService, InvalidAiActionError, type PendingGroupSummary, type ProposedActionsResult } from "../actions/actions.service.js";
import { AiService } from "../ai/ai.service.js";
import type { AiMessage } from "../ai/ai-provider.js";
import { AiStructuredOutputError } from "../ai/ai-provider.js";
import type { AiTurn, ResolvedAction } from "../core/ai-contract.js";
import { answersProposal, type ActionIssue } from "../core/ai-actions.js";
import { aiBurstAllowed } from "../core/ai-usage-policy.js";
import { reviewClarificationDecision, reviewCorrection, reviewPresentation, reviewQuestionLimit, type ReviewKind } from "../core/review-policy.js";
import { budgetHistory } from "../core/ai-history.js";
import { isDomainRuleError } from "../core/errors.js";
import { withTaskCandidates } from "../core/reference-candidates.js";
import { MODEL_REPLY_MAX, REVIEW_REPLY_MAX, compactText } from "../core/telegram-ux.js";
import { localDateAt } from "../core/timezone.js";
import { aiTimeContext } from "../core/ai-time-context.js";
import { renderAppliedReport } from "../core/applied-report.js";
import { bareConfirmationDecision, detectConversationControl, isClearConversationRequest } from "../core/conversation-control.js";
import { emptyWeeklyReviewState, weeklyReviewLifecycle, weeklyReviewProgressFromText, questionForMissingWeeklyDimension, type WeeklyReviewState } from "../core/weekly-review-state.js";
import { ContextService } from "../context/context.service.js";
import { MessagesRepository } from "../messages/messages.repository.js";
import { safeError, safeMessageMetadata } from "../observability/safe-error.js";
import { ensureAssumptionsLabel, normalizeReviewPresentation, removeDanglingContinuation, reviewTopicDirective } from "./review-turn.js";
import { TurnContextService, type TurnContext } from "./turn-context.service.js";
import { hasExplanation, issueCode, renderValidationReply, unclearReply } from "./turn-errors.js";

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
      /** A card the user still saw that this turn replaced; its buttons should go. */
      supersededPendingGroupId?: string;
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

export interface ChatFocus { occurrenceId: string; action: "reschedule" | "blocker" }

type ReviewUi = { kind: ReviewKind; step?: number; totalSteps?: number; completed: boolean } | undefined;

interface TurnScope { workspaceId: string; userId: string; timezone: string; language?: string | null; now: Date }

@Injectable()
export class ChatService {
  constructor(
    private readonly ai: AiService,
    private readonly actions: ActionsService,
    private readonly messages: MessagesRepository,
    private readonly turnContext: TurnContextService,
    private readonly context: ContextService,
    private readonly briefings: BriefingContentService,
  ) {}

  get providerName(): string { return this.ai.providerName; }

  isAiConfigured(): boolean { return this.ai.isConfigured(); }

  get maxMessagesPerHour(): number { return this.ai.maxMessagesPerHour; }

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
    review?: ReviewKind;
    reviewTopicId?: string;
    /** A task card button the user pressed just before typing this text. */
    focus?: ChatFocus;
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
    return this.processPersistedMessage({
      workspaceId: input.workspaceId, userId: input.userId, timezone: input.timezone,
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.review ? { review: input.review } : {}),
      ...(input.reviewTopicId ? { reviewTopicId: input.reviewTopicId } : {}),
      ...(input.focus ? { focus: input.focus } : {}),
      inbound,
    });
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
    const active = await this.context.findActiveTopic(workspaceId, userId);
    return active ? this.context.resolveTopic(workspaceId, userId, active.id) : false;
  }

  async concludeConversation(input: {
    workspaceId: string;
    userId: string;
    aiStatus: "enabled" | "suspended";
    timezone: string;
    language?: string | null;
    topicId?: string;
  }): Promise<ChatProcessResult> {
    const topic = input.topicId
      ? await this.context.findTopic(input.workspaceId, input.userId, input.topicId)
      : await this.context.findActiveTopic(input.workspaceId, input.userId);
    if (!topic) return { kind: "ok", text: "Сейчас нет активного разбора, который нужно завершать.", appliedCount: 0, pendingCount: 0, warnings: [] };

    const summary = topic.summary?.trim() ?? "";
    const fallback = summary ? `Итог по уже сохранённому контексту: ${summary}` : "Обсуждение завершено. Новых действий я не сохранял.";
    const finish = async (text: string): Promise<ChatProcessResult> => {
      await this.context.resolveTopic(input.workspaceId, input.userId, topic.id).catch(() => undefined);
      return {
        kind: "ok", text, appliedCount: 0, pendingCount: 0, warnings: [], topicId: topic.id,
        ...(topic.reviewKind === "evening" || topic.reviewKind === "weekly" ? { review: { kind: topic.reviewKind, completed: true } } : {}),
      };
    };

    if (input.aiStatus !== "enabled" || !this.ai.isConfigured() || !await this.ai.hasConsent(input.userId) || !await this.withinAiLimits(input.userId)) {
      return finish(fallback);
    }

    try {
      const now = new Date();
      const [ctx, historyRows] = await Promise.all([
        this.turnContext.build({ workspaceId: input.workspaceId, userId: input.userId, timezone: input.timezone, ...(input.language !== undefined ? { language: input.language } : {}), query: "", now }),
        this.messages.listRecentForAi(input.workspaceId, input.userId, 20),
      ]);
      const history: AiMessage[] = [
        ...budgetHistory(historyRows.map((row) => ({ role: row.role, content: row.content }))),
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
        domainContext: ctx.model,
        modelMode: ctx.modelMode,
        correction: "This is an explicit conclusion-only control. Return actions=[], question=null. Do not propose or persist any new task, goal, memory, reminder, reschedule or cancellation. Give a best-effort conclusion from known context only.",
        now,
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
    workspaceId: string; userId: string; content: string; telegramChatId: number; telegramMessageId: number; topicId?: string; pendingGroupId?: string;
  }): Promise<void> {
    await this.messages.save({
      workspaceId: input.workspaceId, userId: input.userId, role: "assistant", content: input.content,
      ...(input.topicId ? { topicId: input.topicId } : {}),
      ...(input.pendingGroupId ? { pendingGroupId: input.pendingGroupId } : {}),
      telegramChatId: input.telegramChatId, telegramMessageId: input.telegramMessageId,
    });
  }

  /** Where a confirmation card was shown, so its buttons can be removed once it is superseded. */
  findCardMessage(workspaceId: string, groupId: string): Promise<{ telegramChatId: number; telegramMessageId: number } | null> {
    return this.messages.findByPendingGroup(workspaceId, groupId).then((row) =>
      row?.telegramChatId != null && row.telegramMessageId != null ? { telegramChatId: row.telegramChatId, telegramMessageId: row.telegramMessageId } : null);
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
    topicId: string;
  }): Promise<ChatProcessResult> {
    const initialGate = await this.currentAiAccessGate(input.userId);
    if (initialGate) return initialGate;
    const now = new Date();
    const scope: TurnScope = { workspaceId: input.workspaceId, userId: input.userId, timezone: input.timezone, ...(input.language !== undefined ? { language: input.language } : {}), now };
    const ctx = await this.turnContext.build({ ...scope, query: "", review: input.kind });
    const opening = input.kind === "weekly"
      ? "Начни совместное планирование следующей недели по этому обзору. Сначала кратко назови главные незавершённые или рискованные пункты и задай один вопрос о приоритетах. Ничего не меняй без моего явного выбора."
      : "Начни вечерний обзор по текущим незавершённым делам.";
    const domainContext = ctx.model;

    const providerGate = await this.currentAiAccessGate(input.userId);
    if (providerGate) return providerGate;
    const modelTurn = await this.runModelTurn({
      scope, history: [{ role: "user", content: opening }], domainContext, modelMode: ctx.modelMode,
      correction: `${reviewCorrection(input.kind)}${input.kind === "weekly" ? " This is the opening turn: return actions=[] and ask one planning question." : ""}`,
    });
    if (modelTurn.kind === "unparseable") {
      await this.context.resolveTopic(input.workspaceId, input.userId, input.topicId, now).catch(() => undefined);
      return { kind: "ok", text: "Не смог безопасно собрать обзор. Попробуй ещё раз позже.", appliedCount: 0, pendingCount: 0, warnings: [] };
    }
    const turn = normalizeReviewPresentation(modelTurn.turn, input.kind);
    // The opening turn of a review never changes state: it only frames the conversation.
    const askedQuestion = Boolean(turn.question?.trim());
    const decision = reviewClarificationDecision({ kind: input.kind, clarificationCountBeforeTurn: 0, askedQuestion });
    await this.context.updateClarificationCount({ workspaceId: input.workspaceId, userId: input.userId, topicId: input.topicId, askedQuestion, now }).catch(() => 0);
    if (decision.resolveAfterTurn) await this.context.resolveTopic(input.workspaceId, input.userId, input.topicId, now).catch(() => undefined);
    return {
      kind: "ok",
      text: renderTurn(turn.reply, turn.question),
      appliedCount: 0,
      pendingCount: 0,
      warnings: [],
      topicId: input.topicId,
      ...(decision.checkpoint ? { checkpointTopicId: input.topicId } : {}),
      review: reviewPresentation({ kind: input.kind, clarificationCountBeforeTurn: 0, askedQuestion }),
    };
  }

  /**
   * One user message = one model call. Repair of a malformed structured output happens
   * inside the provider; every other failure is answered deterministically without a
   * second call, because the model cannot change a fact the user got wrong.
   */
  private async processPersistedMessage(input: {
    workspaceId: string; userId: string; timezone: string; language?: string | null; review?: ReviewKind; reviewTopicId?: string; focus?: ChatFocus; inbound: { id: string; content: string };
  }): Promise<ChatProcessResult> {
    try {
      // Re-check after persistence: user/AI status and provider consent can change while the
      // Telegram handler is running. Never rely only on the earlier handler snapshot.
      const initialGate = await this.currentAiGate(input.workspaceId, input.userId, input.inbound.id);
      if (initialGate) return initialGate;
      const now = new Date();
      const scope: TurnScope = { workspaceId: input.workspaceId, userId: input.userId, timezone: input.timezone, ...(input.language !== undefined ? { language: input.language } : {}), now };

      const liveCard = await this.liveCard(input.workspaceId, input.userId, now, input.language);
      const cardReply = await this.resolveCardReply(input, liveCard, now);
      if (cardReply) return cardReply;

      const activeTopicHint = input.reviewTopicId ? await this.context.findTopic(input.workspaceId, input.userId, input.reviewTopicId) : null;
      const ctx = await this.turnContext.build({
        ...scope, query: input.inbound.content,
        ...(input.review ? { review: input.review } : {}),
        ...(input.focus ? { focus: input.focus } : {}),
        pendingGroup: liveCard,
      });
      const activeTopic = ctx.activeTopic ?? (activeTopicHint ? { topicId: activeTopicHint.id, reviewKind: activeTopicHint.reviewKind ?? null, clarificationCount: activeTopicHint.clarificationCount ?? 0, reviewState: activeTopicHint.reviewState ?? null, mode: activeTopicHint.mode } : null);
      const currentTopicId = input.reviewTopicId ?? activeTopic?.topicId;
      const review = input.review ?? (activeTopic?.reviewKind === "evening" || activeTopic?.reviewKind === "weekly" ? activeTopic.reviewKind : undefined);
      const clarificationCountBeforeTurn = activeTopic?.clarificationCount ?? 0;
      const forceReviewConclusion = review
        ? reviewClarificationDecision({ kind: review, clarificationCountBeforeTurn, askedQuestion: false }).forceConclusion
        : false;
      const historyRows = await this.messages.listRecentForAi(input.workspaceId, input.userId, 19);
      const history: AiMessage[] = [
        ...budgetHistory(historyRows.map((row) => ({ role: row.role, content: row.content }))),
        { role: "user", content: input.inbound.content },
      ];
      const domainContext = ctx.model;
      const control = detectConversationControl(input.inbound.content);
      const correction = review
        ? reviewCorrection(review, forceReviewConclusion)
        : control === "no_persist" ? "The user explicitly said not to save anything from this turn. Return actions=[]; ordinary conversational reply is allowed." : undefined;

      const providerGate = await this.currentAiGate(input.workspaceId, input.userId, input.inbound.id);
      if (providerGate) return providerGate;
      const modelTurn = await this.runModelTurn({ scope, history, domainContext, modelMode: ctx.modelMode, ...(correction ? { correction } : {}) });
      if (modelTurn.kind === "unparseable") {
        await this.messages.setStatus(input.workspaceId, input.inbound.id, "processed").catch(() => undefined);
        return { kind: "ok", text: unclearReply(input.language), appliedCount: 0, pendingCount: 0, warnings: [] };
      }
      let turn = normalizeReviewPresentation(modelTurn.turn, review, forceReviewConclusion);
      if (control === "no_persist") turn = { ...turn, actions: [] };
      if (review && currentTopicId) turn = { ...turn, topic: reviewTopicDirective(turn.topic, input.inbound.content, review) };

      const actionScope = { workspaceId: input.workspaceId, actorUserId: input.userId, recipientUserId: input.userId, now, language: input.language ?? null };
      const prepared = turn.actions.length
        ? await this.actions.prepare(turn.actions, ctx.refs, actionScope)
        : { resolved: [] as ResolvedAction[], issues: [] as ActionIssue[] };
      if (prepared.issues.length) {
        const issues = withTaskCandidates(prepared.issues, ctx.refs, input.inbound.content);
        this.logRejectedTurn(input.inbound.id, turn, issues, ctx, input.timezone, now);
        await this.messages.setStatus(input.workspaceId, input.inbound.id, "processed").catch(() => undefined);
        const topicId = await this.applyTopic(input, turn, control, currentTopicId, now);
        return { kind: "ok", text: renderValidationReply(issues, input.language, turn.actions.length), appliedCount: 0, pendingCount: 0, warnings: [], ...(topicId ? { topicId } : {}) };
      }

      // A card the user still sees is replaced only when this turn answers it: the user accepted
      // it in words (the model returns the same change as explicit) or a new proposal takes its
      // place. An unrelated command leaves the card on its buttons. The old card is cancelled
      // after the new package succeeds, so a rejected turn never costs the user the card too.
      let supersededPendingGroupId: string | undefined;
      const acceptsCard = liveCard !== null && prepared.resolved.some((action) => action.intent === "explicit" && answersProposal(action, liveCard.actions));
      let actionResult: ProposedActionsResult = {};
      if (prepared.resolved.length) {
        try {
          actionResult = await this.actions.handleProposed(prepared.resolved, { ...actionScope, sourceMessageId: input.inbound.id });
        } catch (error) {
          // A rule that only the write path can see (a stale row, a definition the target
          // cannot hold) is still information for the user, not a failed turn.
          if (!(error instanceof InvalidAiActionError) && !isDomainRuleError(error)) throw error;
          const issue: ActionIssue = {
            kind: "domain", index: 0,
            code: error instanceof InvalidAiActionError ? error.code : "invalid_action",
            message: error instanceof Error ? error.message : "invalid action",
          };
          this.logRejectedTurn(input.inbound.id, turn, [issue], ctx, input.timezone, now);
          await this.messages.setStatus(input.workspaceId, input.inbound.id, "processed").catch(() => undefined);
          const failedTopicId = await this.applyTopic(input, turn, control, currentTopicId, now);
          return { kind: "ok", text: renderValidationReply([issue], input.language, turn.actions.length), appliedCount: 0, pendingCount: 0, warnings: [], ...(failedTopicId ? { topicId: failedTopicId } : {}) };
        }
      }
      if (liveCard && (acceptsCard || actionResult.pending)) {
        const cancelled = await this.actions.cancel(input.workspaceId, input.userId, liveCard.groupId).catch((error) => {
          console.error("superseded card could not be cancelled", { groupId: liveCard.groupId, error: safeError(error) });
          return false;
        });
        if (cancelled) supersededPendingGroupId = liveCard.groupId;
      }

      const topicId = await this.applyTopic(input, turn, control, currentTopicId, now);
      await this.messages.setStatus(input.workspaceId, input.inbound.id, "processed").catch((error) => {
        console.error("message status update failed after successful turn", { messageId: input.inbound.id, message: safeMessageMetadata(input.inbound.content), error: safeError(error) });
      });

      let checkpoint = false;
      let reviewUi: ReviewUi;
      if (topicId && control !== "no_persist") {
        const askedQuestion = Boolean(turn.question?.trim());
        const count = await this.context.updateClarificationCount({
          workspaceId: input.workspaceId, userId: input.userId, topicId, askedQuestion, now,
        }).catch(() => clarificationCountBeforeTurn);
        if (review === "weekly") {
          const weekly = await this.advanceWeeklyReview({ workspaceId: input.workspaceId, userId: input.userId, topicId, text: input.inbound.content, now, fallbackState: activeTopic?.reviewState ?? null });
          const lifecycle = weeklyReviewLifecycle(weekly, clarificationCountBeforeTurn);
          if (lifecycle.complete) {
            turn = { ...turn, question: null, reply: lifecycle.assumptionsRequired ? ensureAssumptionsLabel(turn.reply) : removeDanglingContinuation(turn.reply) };
          } else if (!turn.question?.trim()) {
            turn = { ...turn, question: questionForMissingWeeklyDimension(weekly) };
          }
          const totalSteps = reviewQuestionLimit("weekly");
          const asked = Boolean(turn.question?.trim());
          checkpoint = !lifecycle.complete && asked && clarificationCountBeforeTurn + 1 >= totalSteps;
          reviewUi = { kind: "weekly", ...(asked ? { step: Math.min(totalSteps, clarificationCountBeforeTurn + 1), totalSteps } : {}), completed: lifecycle.complete };
          if (lifecycle.complete) await this.context.resolveTopic(input.workspaceId, input.userId, topicId, now).catch(() => undefined);
        } else if (review) {
          const decision = reviewClarificationDecision({ kind: review, clarificationCountBeforeTurn, askedQuestion });
          checkpoint = decision.checkpoint;
          reviewUi = reviewPresentation({ kind: review, clarificationCountBeforeTurn, askedQuestion });
          if (decision.resolveAfterTurn) await this.context.resolveTopic(input.workspaceId, input.userId, topicId, now).catch(() => undefined);
        } else if (askedQuestion && count >= 5) {
          checkpoint = true;
          await this.context.resetClarificationCount(input.workspaceId, input.userId, topicId, now).catch(() => undefined);
        }
      }
      const report = actionResult.applied?.items?.length ? renderAppliedReport(actionResult.applied.items, now) : "";
      return {
        kind: "ok",
        text: renderTurn(turn.reply, turn.question, review ? REVIEW_REPLY_MAX : MODEL_REPLY_MAX),
        ...(report ? { report } : {}),
        ...(actionResult.applied && actionResult.applied.undoable !== false ? { appliedGroupId: actionResult.applied.groupId } : {}),
        ...(actionResult.pending ? { pendingGroupId: actionResult.pending.groupId, pendingTitles: actionResult.pending.titles } : {}),
        ...(supersededPendingGroupId ? { supersededPendingGroupId } : {}),
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

  private async runModelTurn(input: {
    scope: TurnScope; history: AiMessage[]; domainContext: unknown; modelMode: "default" | "deep"; correction?: string;
  }): Promise<{ kind: "ok"; turn: AiTurn } | { kind: "unparseable" }> {
    try {
      const turn = await this.ai.respond({
        workspaceId: input.scope.workspaceId,
        userId: input.scope.userId,
        timezone: input.scope.timezone,
        ...(input.scope.language !== undefined ? { language: input.scope.language } : {}),
        messages: input.history,
        domainContext: input.domainContext,
        modelMode: input.modelMode,
        ...(input.correction ? { correction: input.correction } : {}),
        now: input.scope.now,
      });
      return { kind: "ok", turn };
    } catch (error) {
      if (error instanceof AiStructuredOutputError) {
        console.warn("AI structured output unusable after repair", { error: safeError(error) });
        return { kind: "unparseable" };
      }
      throw error;
    }
  }

  /** The confirmation card the user is still looking at, if the bot's last message was one. */
  private async liveCard(workspaceId: string, userId: string, now: Date, language?: string | null): Promise<PendingGroupSummary | null> {
    const last = await this.messages.findLastAssistantMessage(workspaceId, userId).catch(() => null);
    if (!last?.pendingGroupId) return null;
    return this.actions.pendingGroupSummary(workspaceId, userId, last.pendingGroupId, now, language).catch(() => null);
  }

  /**
   * A bare "да" confirms the card the user just saw, not whatever the model would re-derive
   * from prose: re-deriving the target is how an affirmative once landed on another task.
   */
  private async resolveCardReply(
    input: { workspaceId: string; userId: string; language?: string | null; inbound: { id: string; content: string } },
    card: { groupId: string } | null,
    now: Date,
  ): Promise<ChatProcessResult | null> {
    const decision = bareConfirmationDecision(input.inbound.content);
    if (!decision || !card) return null;
    await this.messages.setStatus(input.workspaceId, input.inbound.id, "processed").catch(() => undefined);
    if (decision === "cancel") {
      await this.actions.cancel(input.workspaceId, input.userId, card.groupId).catch(() => false);
      return { kind: "ok", text: confirmationCopy(input.language).declined, appliedCount: 0, pendingCount: 0, warnings: [] };
    }
    try {
      const applied = await this.actions.confirm(input.workspaceId, input.userId, input.userId, card.groupId, now);
      const report = applied.items?.length ? renderAppliedReport(applied.items, now) : "";
      return {
        kind: "ok",
        text: confirmationCopy(input.language).confirmed,
        ...(report ? { report } : {}),
        ...(applied.undoable !== false ? { appliedGroupId: applied.groupId } : {}),
        appliedCount: applied.count,
        pendingCount: 0,
        warnings: [],
      };
    } catch (error) {
      console.warn("typed confirmation failed", { groupId: card.groupId, error: safeError(error) });
      return { kind: "ok", text: confirmationCopy(input.language).expired, appliedCount: 0, pendingCount: 0, warnings: [] };
    }
  }

  /** The topic directive never blocks a turn: a failure is logged and the active topic stays. */
  private async applyTopic(
    input: { workspaceId: string; userId: string; inbound: { id: string; content: string } },
    turn: AiTurn,
    control: ReturnType<typeof detectConversationControl>,
    currentTopicId: string | undefined,
    now: Date,
  ): Promise<string | null> {
    if (control === "no_persist") return currentTopicId ?? null;
    try {
      return await this.context.applyTopicDirective({ workspaceId: input.workspaceId, userId: input.userId, messageId: input.inbound.id, directive: turn.topic, now });
    } catch (error) {
      console.error("topic update failed after successful turn", { messageId: input.inbound.id, message: safeMessageMetadata(input.inbound.content), error: safeError(error) });
      return currentTopicId ?? null;
    }
  }

  private async advanceWeeklyReview(input: { workspaceId: string; userId: string; topicId: string; text: string; now: Date; fallbackState: unknown }): Promise<WeeklyReviewState> {
    const state = await this.context.mergeWeeklyReviewProgress({
      workspaceId: input.workspaceId, userId: input.userId, topicId: input.topicId,
      progress: weeklyReviewProgressFromText(input.text), now: input.now,
    }).catch(() => (input.fallbackState as WeeklyReviewState | null) ?? emptyWeeklyReviewState());
    console.info("weekly review progress", {
      topicId: input.topicId,
      providedCount: [state.outcome, state.capacityEnergy, state.risks, state.minimumSuccess, state.commitments].filter(Boolean).length,
    });
    return state;
  }

  private logRejectedTurn(messageId: string, turn: AiTurn, issues: readonly ActionIssue[], ctx: TurnContext, timezone: string, now: Date): void {
    console.warn("AI action rejected", {
      messageId,
      actionTypes: turn.actions.map((action) => action.type),
      intents: turn.actions.map((action) => action.intent),
      // The rule text is kept only for codes without a user-facing explanation, so an unmapped
      // rule stays debuggable in the log instead of leaking into the reply.
      issues: issues.map((issue) => ({
        kind: issue.kind, index: issue.index, code: issueCode(issue), candidateCount: issue.candidates?.length ?? 0,
        ...(hasExplanation(issueCode(issue)) ? {} : { rule: issue.message.slice(0, 160) }),
      })),
      context: ctx.meta,
      timeContext: aiTimeContext(now, timezone),
    });
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

function confirmationCopy(language: string | null | undefined): { confirmed: string; declined: string; expired: string } {
  const locale = language?.toLocaleLowerCase() ?? "";
  if (locale.startsWith("uk")) {
    return {
      confirmed: "Підтверджено.",
      declined: "Скасував пропозицію, нічого не змінив.",
      expired: "Підтвердження вже не діє — пропозиція застаріла. Напиши, що саме зробити.",
    };
  }
  if (locale.startsWith("en")) {
    return {
      confirmed: "Confirmed.",
      declined: "Dropped the proposal, nothing changed.",
      expired: "That confirmation no longer applies — the proposal expired. Tell me what to do.",
    };
  }
  return {
    confirmed: "Подтверждено.",
    declined: "Снял предложение, ничего не изменил.",
    expired: "Подтверждение уже не действует — предложение устарело. Напиши, что именно сделать.",
  };
}

function aiHistoryClearedText(language: string | null | undefined, count: number): string {
  if (language?.toLowerCase().startsWith("uk")) return `AI-історію очищено (${count} повідомлень). Повідомлення Telegram, завдання, цілі, нагадування й налаштування не змінені.`;
  if (language?.toLowerCase().startsWith("en")) return `AI history cleared (${count} messages). Telegram messages, tasks, goals, reminders, and settings are unchanged.`;
  return `AI-история очищена (${count} сообщений). Сообщения Telegram, задачи, цели, напоминания и настройки не изменены.`;
}

/**
 * The model's prose plus its one question, within Telegram's budget for prose. The reply is
 * shortened first so the question, which the whole turn may hinge on, is never the part cut off.
 */
export function renderTurn(reply: string, question: string | null, maxLength = MODEL_REPLY_MAX): string {
  const trimmed = reply.trim();
  const q = question?.trim() ?? "";
  if (!q || normalizedText(trimmed).includes(normalizedText(q))) return compactText(trimmed, maxLength);
  const replyBudget = Math.max(40, maxLength - q.length - 2);
  return `${compactText(trimmed, replyBudget)}\n\n${q}`;
}

function normalizedText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[«»'"`.,!?;:—–-]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
