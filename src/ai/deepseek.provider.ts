import OpenAI from "openai";
import type { AppConfig } from "../config.js";
import { AiTurnSchema } from "./ai-contracts.js";
import type { AiProvider, AiProviderResult, AiRequest } from "./ai-provider.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_JSON_INSTRUCTION = [
  "Return only one valid JSON object. Do not use markdown or prose outside JSON.",
  'Top level: {"reply":string,"question":string|null,"profileInvitation":boolean,"topic":TopicDirective,"topicModeSuggestion":"normal"|"analysis"|null,"goalAnalysisFocus":{"goalId":string,"expectedVersion":number}|null,"reviewProgress":{"outcome":Dimension|null,"capacityEnergy":Dimension|null,"risks":Dimension|null,"minimumSuccess":Dimension|null,"commitments":Dimension|null,"conclusionRequested":boolean}|null,"actions":Action[]}. Dimension={"status":"provided"|"skipped","summary":string}.',
  "TopicDirective fields: mode,topicId,title,summary. Use null where a nullable topic field is absent.",
  "Action is exactly one of create_task, task_batch, create_goal_plan, update_task, complete_occurrence, update_occurrence, reschedule_occurrence, create_goal, update_goal, save_memory, update_memory, delete_memory, link_task_to_goal, change_reminder, change_series, update_settings.",
  "create_task fields: type,source,confidence,criticalExplicit,habitModeExplicit,title,why,nextAction,context,checklist,goalLink,definition. definition includes localSchedule and recurrence; use those structured objects for new schedules and set legacy planned*/due*/reviewAt/recurrenceRule fields to null. why is only a reason the user gave, never a paraphrase of the title, otherwise null; nextAction is the first real-world step only when the task is larger than one action and the step differs from the title and the first checklist item, never a planning chore, otherwise null; context is a concise durable task-specific nuance, constraint or desired quality from the user not already in the other fields, otherwise null. checklist is null or [{text,done}]. goalLink is null or {goalId,expectedGoalVersion,confidence} for one clearly matching listed active goal. reminder is null (keep the default reminder) or the same object as change_reminder.reminder when the user asked for a specific reminder on the new task; quietBypassExplicit is a boolean.",
  "update_task fields: type,source,confidence,taskId,expectedVersion,criticalExplicit,habitModeExplicit,patch. patch fields: title,why,nextAction,context,importance,checklist,habitMode,minimumAction,desiredAction,habitTrigger; checklist is [{text,done}]; use null for unchanged fields.",
  "complete_occurrence fields: type,source,confidence,occurrenceId,expectedVersion.",
  "update_occurrence fields: type,source,confidence,occurrenceId,expectedVersion,operation,details. operation is start|skip|cancel|seen|record_blocker; details is required only for record_blocker and null otherwise.",
  "reschedule_occurrence fields: type,source,confidence,occurrenceId,expectedVersion,reason,schedule. schedule.localSchedule={mode,timezone,startDate,startTime,endDate,endTime,dueDate,dueTime,durationMinutes,fuzzyHorizonText,reviewDate,reviewTime}; set legacy schedule fields to null.",
  "create_goal fields: type,source,confidence,title,why,targetLocalDate.",
  "create_goal_plan fields: type,source,confidence,goal,tasks. Use it only when the user explicitly asks to create a new goal together with its initial new tasks; goal={title,why,targetLocalDate}, tasks are create_task fields except type/source/confidence/goalLink. The server creates links to the new goal atomically.",
  "task_batch fields: type,source,confidence,steps. steps has 1–12 ordered task-only items with unique stepId and operation=create|update|reschedule|link_goal. Each step carries source/confidence and the corresponding create/update/reschedule/link fields. link_goal.target may be {kind:'created',stepId} for an earlier create or {kind:'persisted',taskId,expectedTaskVersion}; update requires persisted target. Never include memory/settings/account work.",
  "update_goal fields: type,source,confidence,goalId,expectedVersion,patch. patch fields: title,why,targetLocalDate,status,reviewEnabled; use null for unchanged fields.",
  "save_memory fields: type,source,confidence,memoryType,content,sensitive.",
  "update_memory fields: type,source,confidence,memoryId,expectedVersion,patch. patch fields: content,sensitive; use null for unchanged fields.",
  "delete_memory fields: type,source,confidence,memoryId,expectedVersion.",
  "link_task_to_goal fields: type,source,confidence,taskId,expectedTaskVersion,goalId,expectedGoalVersion.",
  "change_reminder fields: type,source,confidence,occurrenceId,expectedVersion,mode,quietBypassExplicit,reminder; reminder is null for clear or {triggerKind,exactAt,anchor,offsetMinutes,daysOffset,localTime,quietPolicy}. triggerKind is exact|relative_timestamp|local_date; use null for fields irrelevant to the chosen trigger.",
  "change_series fields: type,source,confidence,taskId,expectedVersion,operation,edit. operation is pause|resume|stop|cancel|edit; edit must be null except for edit operation, where it contains timezone,recurrenceTimezone,missPolicy,localSchedule,recurrence and nullable legacy fields. recurrence={frequency,interval,startsOn,endsOn,weekdays,monthDays,localTimes,excludedLocalDates}; set recurrenceRule=null.",
  "update_settings fields: type,source,confidence,expectedVersion,operation,timezone,applyTimezoneTo,language,digestKind,enabled,time,weekday,weekdayStart,weekdayEnd,weekendStart,weekendEnd,snoozeUntil,eventOffsets,plannedTaskOffsetMinutes,criticalPostDueMinutes,seenNormalMinutes,seenRequiredMinutes,seenCriticalMinutes. operation is timezone|language|digest|weekly_review|quiet_hours|snooze|reminder_defaults; use null for fields irrelevant to the operation.",
  "Use null for absent nullable fields. The application will reject any missing, invented or extra-invalid structure.",
].join("\n");

export class DeepSeekProvider implements AiProvider {
  readonly name = "deepseek";
  private readonly client: OpenAI | null;

  constructor(config: AppConfig) {
    this.client = config.deepSeekApiKey
      ? new OpenAI({ apiKey: config.deepSeekApiKey, baseURL: DEEPSEEK_BASE_URL, maxRetries: 0 })
      : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async generate(request: AiRequest): Promise<AiProviderResult> {
    if (!this.client) throw new Error("DeepSeek is not configured");
    let lastStructuredError: unknown;
    let inputTokens = 0;
    let outputTokens = 0;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Transport/API errors are deliberately not retried here. Durable retry policy lives
      // in MessagesRepository so restart semantics, attempt counts and cost remain observable.
      const response = await this.client.chat.completions.create({
        model: request.model,
        messages: [
          {
            role: "system",
            content: `${request.systemPrompt}\n\n${DEEPSEEK_JSON_INSTRUCTION}${attempt ? "\nPrevious structured output was invalid. Return one object matching the contract exactly." : ""}`,
          },
          ...request.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
        response_format: { type: "json_object" },
      });
      inputTokens += response.usage?.prompt_tokens ?? 0;
      outputTokens += response.usage?.completion_tokens ?? 0;

      try {
        const content = response.choices[0]?.message.content?.trim();
        if (!content) throw new Error("DeepSeek returned empty JSON output");
        const turn = AiTurnSchema.parse(JSON.parse(content));
        return {
          turn,
          ...(response.id ? { requestId: response.id } : {}),
          ...(inputTokens ? { inputTokens } : {}),
          ...(outputTokens ? { outputTokens } : {}),
        };
      } catch (error) {
        lastStructuredError = error;
      }
    }
    throw lastStructuredError instanceof Error ? lastStructuredError : new Error("DeepSeek returned invalid structured output");
  }
}
