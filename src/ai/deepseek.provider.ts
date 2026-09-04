import type OpenAI from "openai";
import type { AppConfig } from "../config.js";
import { createOpenAiCompatibleClient } from "./ai-client.js";
import { AiTurnSchema } from "./ai-contracts.js";
import { AiStructuredOutputError, describeStructuredIssues, structuredRepairSuffix, type AiProvider, type AiProviderResult, type AiRequest } from "./ai-provider.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_JSON_INSTRUCTION = [
  "Return only one valid JSON object. Do not use markdown or prose outside JSON. Every listed field must be present; use null where a nullable field is absent.",
  'Top level: {"reply":string,"question":string|null,"actions":Action[],"topic":{"mode":"none"|"continue"|"new"|"resolve","title":string|null,"summary":string|null}}.',
  "Every Action has type and intent (\"explicit\" when the user asked for exactly this action or accepted your proposal; \"inferred\" when you propose it yourself). Entities are referenced by the short ids from CURRENT_CONTEXT as {\"id\":\"t1\"} (tasks t*, goals g*, memory m*).",
  "When = {mode:\"exact\",date:\"YYYY-MM-DD\",time:\"HH:mm\",durationMinutes:number|null} | {mode:\"date\",date} | {mode:\"deadline\",date,time:string|null} | {mode:\"fuzzy\",horizonText:string,reviewDate:\"YYYY-MM-DD\"}.",
  "Recurrence = {frequency:\"daily\"|\"weekly\"|\"monthly\",interval:number,weekdays:[\"MO\"..\"SU\"]|null,monthDays:number[]|null,until:date|null,skipDates:date[]|null,missed:\"expire\"|\"carry_over\"|null}.",
  "Reminder = {kind:\"at\",date,time,quiet} | {kind:\"offset\",anchor:\"start\"|\"end\"|\"due\",minutes:number,quiet} | {kind:\"day\",anchor:\"start\"|\"due\",daysOffset:number,time,quiet}; quiet is \"respect\"|\"bypass\".",
  "TaskBody fields: title,why,nextAction,context,checklist([{text,done}]|null),importance(\"normal\"|\"required\"|\"critical\"),kind(\"task\"|\"event\"),when,recurrence|null,reminder|null,habit({minimumAction,desiredAction,trigger}|null),timezone|null.",
  "create_task: TaskBody fields plus goal({id}|null). update_task: task({id}),patch{title,why,nextAction,context,checklist,importance,habit({minimumAction,desiredAction,trigger}|{enabled:false}|null)} with null for unchanged fields.",
  "set_task_state: task,state(\"done\"|\"started\"|\"seen\"|\"skipped\"|\"cancelled\"),note(string|null; with seen it records a blocker),scope(\"occurrence\"|\"series\"|null).",
  "reschedule: task,when,reason(string|null),scope(\"occurrence\"|\"series\"|null),recurrence(only with scope=series, else null),timezone|null.",
  "set_reminder: task,mode(\"add\"|\"replace\"|\"clear\"),reminder(Reminder|null; null only with clear).",
  "goal: op(\"create\"|\"update\"|\"link\"|\"unlink\"),goal({id}|null),task({id}|null),title,why,targetDate,status(\"active\"|\"paused\"|\"completed\"|\"cancelled\"|null),reviewEnabled(boolean|null).",
  "plan: goal{title,why,targetDate},tasks(TaskBody[1..12]). memory: op(\"save\"|\"update\"|\"delete\"),item({id}|null),kind(\"note\"|\"decision\"|\"preference\"|\"context\"|null),content,sensitive(boolean|null).",
  "settings: operation(\"timezone\"|\"language\"|\"digest\"|\"weekly_review\"|\"quiet_hours\"|\"snooze\"|\"reminder_defaults\"),timezone,applyTimezoneTo(\"profile_only\"|\"all\"|null),language,digestKind(\"morning\"|\"evening\"|null),enabled,time,weekday(1=Monday..7=Sunday),weekdayStart,weekdayEnd,weekendStart,weekendEnd,snoozeUntilDate,snoozeUntilTime,eventOffsets,plannedTaskOffsetMinutes,criticalPostDueMinutes,seenNormalMinutes,seenRequiredMinutes,seenCriticalMinutes; null for fields irrelevant to the operation.",
  "The application rejects any missing, invented or extra field.",
].join("\n");

export class DeepSeekProvider implements AiProvider {
  readonly name = "deepseek";
  private readonly client: OpenAI | null;

  constructor(config: AppConfig) {
    this.client = config.deepSeekApiKey
      ? createOpenAiCompatibleClient({ apiKey: config.deepSeekApiKey, baseURL: DEEPSEEK_BASE_URL })
      : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async generate(request: AiRequest): Promise<AiProviderResult> {
    if (!this.client) throw new Error("DeepSeek is not configured");
    let inputTokens = 0;
    let outputTokens = 0;
    let issues: string[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Transport/API errors are deliberately not retried here. Durable retry policy lives
      // in MessagesRepository so restart semantics, attempt counts and cost remain observable.
      const response = await this.client.chat.completions.create({
        model: request.model,
        messages: [
          {
            role: "system",
            content: `${request.systemPrompt}\n\n${DEEPSEEK_JSON_INSTRUCTION}${attempt ? `\n${structuredRepairSuffix(issues)}` : ""}`,
          },
          ...request.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
        response_format: { type: "json_object" },
      });
      inputTokens += response.usage?.prompt_tokens ?? 0;
      outputTokens += response.usage?.completion_tokens ?? 0;

      const content = response.choices[0]?.message.content?.trim();
      if (!content) {
        issues = [];
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch {
        issues = ["(root): invalid_json"];
        continue;
      }
      const parsed = AiTurnSchema.safeParse(json);
      if (!parsed.success) {
        issues = describeStructuredIssues(parsed.error);
        continue;
      }
      return {
        turn: parsed.data,
        ...(response.id ? { requestId: response.id } : {}),
        ...(inputTokens ? { inputTokens } : {}),
        ...(outputTokens ? { outputTokens } : {}),
      };
    }
    throw new AiStructuredOutputError("DeepSeek returned no valid structured output after one repair attempt");
  }
}
