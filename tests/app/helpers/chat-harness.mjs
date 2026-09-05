import { ChatService } from "../../../dist/chat/chat.service.js";
import { AiStructuredOutputError } from "../../../dist/ai/ai-provider.js";
import { EMPTY_REFS } from "../../../dist/core/ai-refs.js";

/**
 * A ChatService wired to plain fakes: no DI container, no database, no provider.
 * Every collaborator records what the pipeline asked of it, so a test can assert the
 * shape of a turn (one model call, no correction, one action package) rather than text.
 *
 * Scripted inputs
 *   turns          AiTurn per `ai.respond` call, in order. An `Error` instance is thrown
 *                  instead of returned; `"unparseable"` throws AiStructuredOutputError.
 *   issues         ActionIssue[] per `actions.prepare` call, in order (default []).
 *   applied        `{ applied }` payload for `handleProposed`; array = per call,
 *                  `null` = return {} (nothing persisted). Default: everything applied.
 *   pending        `{ pending }` payload for `handleProposed`; array = per call. Wins over `applied`.
 *   context        merged into the object `turnContext.build` returns.
 *   lastAssistant  row returned by `messages.findLastAssistantMessage`.
 *   pendingSummary what `actions.pendingGroupSummary` returns (null = no live card).
 *   confirmResult  what `actions.confirm` resolves to (an Error instance is thrown).
 *
 * Recorded output
 *   calls          `{ correction, domainContext, modelMode }` per `ai.respond`
 *   corrections    just the corrections, in order
 *   prepared       `{ actions, refs, scope }` per `actions.prepare`
 *   handled        `{ resolved, scope, cancelledBefore }` per `actions.handleProposed`
 *   cancelled      group ids passed to `actions.cancel`
 *   confirmed      group ids passed to `actions.confirm`
 *   statuses       `{ messageId, status }` per `messages.setStatus`
 *   retries        message ids passed to `messages.scheduleAiRetry`
 *   topics         directives passed to `context.applyTopicDirective`
 */
export function createChatHarness(options = {}) {
  const {
    turns = [],
    issues = [],
    applied,
    pending,
    context: contextOverrides = {},
    lastAssistant = null,
    pendingSummary = null,
    confirmResult,
    clarificationCount = 1,
    topicId = null,
  } = options;

  const calls = [];
  const corrections = [];
  const prepared = [];
  const handled = [];
  const cancelled = [];
  const confirmed = [];
  const statuses = [];
  const retries = [];
  const topics = [];
  const saved = [];

  const perCall = (value, index) => (Array.isArray(value) ? value[index] : value);

  const ai = {
    providerName: "fake",
    consentVersion: "v1",
    maxMessagesPerHour: 60,
    maxCallsPerHour: 60,
    isConfigured: () => true,
    hasConsent: async () => true,
    hasProviderConsent: async () => true,
    grantConsent: async () => undefined,
    grantProviderConsent: async () => undefined,
    revokeProviderConsent: async () => undefined,
    callsLastHour: async () => 0,
    respond: async (input) => {
      calls.push({ correction: input.correction, domainContext: input.domainContext, modelMode: input.modelMode, messages: input.messages });
      corrections.push(input.correction);
      const scripted = turns[calls.length - 1];
      if (scripted === undefined) throw new Error(`no scripted AI turn for call #${calls.length}`);
      if (scripted === "unparseable") throw new AiStructuredOutputError("structured output unusable after repair");
      if (scripted instanceof Error) throw scripted;
      return scripted;
    },
  };

  const actions = {
    prepare: async (list, refs, scope) => {
      prepared.push({ actions: list, refs, scope });
      return {
        resolved: list.map(resolveLikeServer),
        issues: perCall(issues, prepared.length - 1) ?? [],
      };
    },
    handleProposed: async (resolved, scope) => {
      handled.push({ resolved, scope, cancelledBefore: cancelled.length });
      const index = handled.length - 1;
      const scriptedPending = perCall(pending, index);
      if (scriptedPending) {
        return {
          pending: {
            groupId: scriptedPending.groupId ?? "pending-group",
            count: scriptedPending.count ?? resolved.length,
            titles: scriptedPending.titles ?? [],
          },
        };
      }
      const scriptedApplied = perCall(applied, index);
      if (scriptedApplied === null) return {};
      return {
        applied: {
          groupId: scriptedApplied?.groupId ?? "applied-group",
          count: scriptedApplied?.count ?? resolved.length,
          titles: scriptedApplied?.titles ?? [],
          items: scriptedApplied?.items ?? [],
          ...(scriptedApplied?.undoable !== undefined ? { undoable: scriptedApplied.undoable } : {}),
        },
      };
    },
    cancel: async (_workspaceId, _actorUserId, groupId) => {
      cancelled.push(groupId);
      return true;
    },
    confirm: async (_workspaceId, _actorUserId, _recipientUserId, groupId) => {
      confirmed.push(groupId);
      if (confirmResult instanceof Error) throw confirmResult;
      return confirmResult ?? { groupId, count: 1, titles: [], items: [] };
    },
    pendingGroupSummary: async (_workspaceId, _actorUserId, groupId) => {
      const summary = typeof pendingSummary === "function" ? pendingSummary(groupId) : pendingSummary;
      return summary ? { actions: [], ...summary } : summary;
    },
  };

  let messageSeq = 0;
  const messages = {
    saveOnce: async (row) => {
      messageSeq += 1;
      const message = { id: `msg-${messageSeq}`, content: row.content };
      saved.push({ ...row, id: message.id });
      return { inserted: true, message };
    },
    save: async (row) => {
      saved.push(row);
      return { id: `msg-out-${saved.length}` };
    },
    setStatus: async (_workspaceId, messageId, status) => {
      statuses.push({ messageId, status });
    },
    listRecentForAi: async () => [],
    countUserMessagesSince: async () => 0,
    isAiProcessingAllowed: async () => true,
    scheduleAiRetry: async (_workspaceId, _userId, messageId) => {
      retries.push(messageId);
    },
    deferAiUntil: async () => undefined,
    findLatestRetryable: async () => null,
    claimRetryable: async () => null,
    findLastAssistantMessage: async () => lastAssistant,
    findByPendingGroup: async () => null,
    clearConversation: async () => 0,
    countConversation: async () => 0,
  };

  const turnContext = {
    build: async () => ({
      model: { tasks: [], goals: [], memory: [], settings: {}, topic: { active: null, recent: [] } },
      refs: EMPTY_REFS,
      activeTopic: null,
      modelMode: "default",
      meta: { tasksShown: 0, tasksTotal: 0, truncated: false },
      ...contextOverrides,
    }),
  };

  const context = {
    applyTopicDirective: async (input) => {
      topics.push(input.directive);
      return topicId;
    },
    findActiveTopic: async () => contextOverrides.activeTopic ?? null,
    findTopic: async () => null,
    resolveTopic: async () => true,
    updateClarificationCount: async () => clarificationCount,
    resetClarificationCount: async () => undefined,
    mergeWeeklyReviewProgress: async () => ({
      outcome: null,
      capacityEnergy: null,
      risks: null,
      minimumSuccess: null,
      commitments: null,
    }),
    pauseActiveTopics: async () => 0,
  };

  const briefings = { build: async () => ({ text: "СНИМОК НЕДЕЛИ" }) };

  const chat = new ChatService(ai, actions, messages, turnContext, context, briefings);
  return { chat, calls, corrections, prepared, handled, cancelled, confirmed, statuses, retries, topics, saved };
}

/**
 * The shape ActionsService.prepare produces, approximated: model fields are kept (tests assert on
 * them) and the server-side target/ids are added so code that reads `target.taskId` works.
 */
export function resolveLikeServer(action) {
  const taskTarget = (ref) =>
    ref ? { kind: "occurrence", taskId: `task:${ref.id}`, taskVersion: 1, occurrenceId: `occurrence:${ref.id}`, occurrenceVersion: 1, timezone: "Europe/Kyiv" } : null;
  const base = { ...action, resolved: true, timezone: "Europe/Kyiv", reviewTime: "09:00" };
  switch (action.type) {
    case "create_task": {
      const { type: _type, intent: _intent, goal, ...body } = action;
      return { ...base, body, goal: goal ? { goalId: `goal:${goal.id}`, goalVersion: 1 } : null };
    }
    case "update_task":
      return { ...base, taskId: `task:${action.task.id}`, taskVersion: 1 };
    case "set_task_state":
    case "reschedule":
    case "set_reminder":
      return { ...base, target: taskTarget(action.task) };
    case "goal":
      return {
        ...base,
        goalId: action.goal ? `goal:${action.goal.id}` : null,
        goalVersion: action.goal ? 1 : null,
        taskId: action.task ? `task:${action.task.id}` : null,
        taskVersion: action.task ? 1 : null,
      };
    case "memory":
      return { ...base, memoryId: action.item ? `memory:${action.item.id}` : null, memoryVersion: action.item ? 1 : null };
    default:
      return base;
  }
}
