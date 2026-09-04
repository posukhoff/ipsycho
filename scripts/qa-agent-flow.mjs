/**
 * Replays the real-dialog phrasings from docs/AGENT_FLOW.md §2.7 plus the yes/no card
 * ownership sequence against the live provider, inside a throwaway workspace.
 *
 * Usage: node scripts/qa-agent-flow.mjs  (needs DATABASE_URL, AI_* and a built dist/)
 * Prints JSON: per-message outcome, provider calls per message, mean input tokens.
 */
import { randomUUID } from "node:crypto";
import { loadConfig } from "../dist/config.js";
import { DatabaseService } from "../dist/database/database.service.js";
import { OpenAiProvider } from "../dist/ai/openai.provider.js";
import { GeminiProvider } from "../dist/ai/gemini.provider.js";
import { DeepSeekProvider } from "../dist/ai/deepseek.provider.js";
import { AiRepository } from "../dist/ai/ai.repository.js";
import { AiService } from "../dist/ai/ai.service.js";
import { MessagesRepository } from "../dist/messages/messages.repository.js";
import { TasksRepository } from "../dist/tasks/tasks.repository.js";
import { TasksService } from "../dist/tasks/tasks.service.js";
import { RecurrenceMaintenanceService } from "../dist/tasks/recurrence-maintenance.service.js";
import { ContextRepository } from "../dist/context/context.repository.js";
import { ContextActionsRepository } from "../dist/context/context-actions.repository.js";
import { ContextService } from "../dist/context/context.service.js";
import { SettingsService } from "../dist/settings/settings.service.js";
import { ActionsRepository } from "../dist/actions/actions.repository.js";
import { ActionMutationsRepository } from "../dist/actions/action-mutations.repository.js";
import { ActionGroupRepository } from "../dist/actions/action-group.repository.js";
import { ActionsService } from "../dist/actions/actions.service.js";
import { ReminderSchedulingService } from "../dist/reminders/reminder-scheduling.service.js";
import { BriefingContentService } from "../dist/briefings/briefing-content.service.js";
import { TurnContextService } from "../dist/chat/turn-context.service.js";
import { ChatService } from "../dist/chat/chat.service.js";

const config = loadConfig(process.env);
const database = new DatabaseService(config);
const provider = config.aiProvider === "openai" ? new OpenAiProvider(config) : config.aiProvider === "gemini" ? new GeminiProvider(config) : new DeepSeekProvider(config);
const ai = new AiService(config, provider, new AiRepository(database));
const messages = new MessagesRepository(database);
const queue = { enqueue: async () => undefined };
const recurrence = new RecurrenceMaintenanceService(database, queue);
const tasksRepository = new TasksRepository(database);
const tasks = new TasksService(tasksRepository, queue, recurrence);
const settings = new SettingsService(database);
const contextRepository = new ContextRepository(database);
const context = new ContextService(contextRepository);
const reminders = new ReminderSchedulingService(database, queue);
const briefings = new BriefingContentService(database);
const actions = new ActionsService(
  new ActionsRepository(database),
  new ActionMutationsRepository(database),
  new ActionGroupRepository(database),
  tasks,
  reminders,
  context,
  new ContextActionsRepository(database),
  settings,
);
const issuesSeen = [];
const prepare = actions.prepare.bind(actions);
actions.prepare = async (...args) => {
  const result = await prepare(...args);
  if (result.issues.length) issuesSeen.push(result.issues.map((issue) => ({ kind: issue.kind, code: issue.code, message: issue.message })));
  return result;
};
const turnContext = new TurnContextService(tasks, contextRepository, settings, briefings);
const chat = new ChatService(ai, actions, messages, turnContext, context, briefings);

const userId = randomUUID();
const workspaceId = randomUUID();
const telegramId = BigInt(`8${String(Date.now()).slice(-14)}`);
const timezone = "Europe/Kyiv";
const transcript = [];
let telegramMessageId = 7_000_000;

async function record(label, result) {
  const entry = {
    label,
    kind: result.kind,
    ...(result.kind === "ok"
      ? { text: result.text, report: result.report ?? null, applied: result.appliedCount, pending: result.pendingCount, pendingTitles: result.pendingTitles ?? [] }
      : {}),
  };
  transcript.push(entry);
  if (result.kind === "ok" && !result.skipAssistantHistory) {
    telegramMessageId += 1;
    await chat.recordAssistantMessage({
      workspaceId,
      userId,
      content: result.text,
      telegramChatId: Number(telegramId),
      telegramMessageId,
      ...(result.topicId ? { topicId: result.topicId } : {}),
      ...(result.pendingGroupId ? { pendingGroupId: result.pendingGroupId } : {}),
    });
  }
  return result;
}

async function send(text) {
  telegramMessageId += 1;
  const before = await database.pool.query("select count(*)::int as count from ai_usage where user_id=$1", [userId]);
  const result = await chat.processText({
    workspaceId,
    userId,
    aiStatus: "enabled",
    timezone,
    language: "ru",
    text,
    telegramChatId: Number(telegramId),
    telegramMessageId,
  });
  const after = await database.pool.query("select count(*)::int as count from ai_usage where user_id=$1", [userId]);
  const recorded = await record(text, result);
  transcript[transcript.length - 1].providerCalls = after.rows[0].count - before.rows[0].count;
  return recorded;
}

try {
  await database.pool.query("insert into users(id, telegram_user_id) values ($1,$2)", [userId, telegramId]);
  await database.pool.query("insert into workspaces(id, owner_user_id) values ($1,$2)", [workspaceId, userId]);
  await database.pool.query("insert into workspace_members(workspace_id,user_id,role) values ($1,$2,'owner')", [workspaceId, userId]);
  await database.pool.query("insert into user_settings(user_id,timezone,digest_timezone,quiet_hours_timezone) values ($1,$2,$2,$2)", [userId, timezone]);
  await database.pool.query(
    "insert into goals(id,workspace_id,created_by_user_id,title,why) values ($1,$2,$3,'Запустить первую платную группу курса','Проверить спрос без выгорания')",
    [randomUUID(), workspaceId, userId],
  );
  await ai.grantConsent(userId);

  const r1 = await send("Создай задачу: завтра в 10:30 позвонить клиенту, цель — честно объяснить ошибку и предложить два варианта решения. Напомни в момент начала.");
  const r2 = await send("Напомни через четыре часа посмотреть курс по ИИ");
  const r3 = await send("Закинь мне на понедельник в полдесятого утра созвон с дизайнером минут на сорок.");
  const r4 = await send("Перенеси созвон с дизайнером на понедельник в 16:00, а звонок клиенту на четверг с 15:00 до 16:00.");
  const r5 = await send("Создай задачу «Попросить обратную связь по лендингу» на пятницу в 12:00 и свяжи её с целью запуска группы.");
  const r6 = await send("Поставь с сентября каждый второй понедельник в 9:15 финансовый обзор на 30 минут, до конца ноября.");
  const r7 = await send("Каждый вторник в 19:00 до октября хочу заниматься английским час, но ближайший вторник пропусти.");
  const r8 = await send(
    "Добавь сразу четыре дела: 1) в понедельник в 14:00 забрать документы; 2) во вторник до 17:00 отправить бухгалтеру выписку; 3) в четверг с 10:00 до 11:00 подготовиться к сложному разговору; 4) по будням в 8:00 до 30 сентября 10 минут планировать день — это именно повторяющаяся привычка, минимум открыть план и выбрать одно главное дело, желаемый вариант — расписать три приоритета.",
  );
  const r9 = await send("Не дай забыть: завтра после обеда надо забрать посылку. Точного часа не знаю, не придумывай его сам.");
  const cancel = await send("Отмени созвон с дизайнером");
  const yes = cancel.kind === "ok" && cancel.pendingGroupId ? await send("да") : null;

  const usage = await database.pool.query("select count(*)::int as calls, round(avg(input_tokens))::int as input_tokens from ai_usage where user_id=$1", [userId]);
  const userMessages = transcript.filter((item) => item.providerCalls !== undefined).length;
  const settled = (result) => result.kind === "ok" && (result.appliedCount > 0 || result.pendingCount > 0);
  const refFailures = issuesSeen.flat().filter((issue) => issue.code === "ref_not_found" || issue.code === "ref_required" || issue.code === "ref_kind_mismatch");
  const checks = [
    { name: "create with reminder settles in one call", pass: settled(r1) && transcript[0].providerCalls === 1 },
    { name: "remind in four hours settles", pass: settled(r2) },
    { name: "event with duration settles", pass: settled(r3) },
    { name: "two reschedules in one message settle together", pass: settled(r4) },
    { name: "create + goal link package settles", pass: settled(r5) },
    { name: "every second Monday recurrence settles", pass: settled(r6) },
    { name: "weekly recurrence with skipped first date settles", pass: settled(r7) },
    { name: "four tasks with a habit settle as one package", pass: settled(r8) },
    { name: "date without time settles", pass: settled(r9) },
    // A task the user is creating right now must never be addressed by id: the model has
    // create_task's own reminder/goal/recurrence fields for that.
    { name: "no action references a task that does not exist", pass: refFailures.length === 0 },
    { name: "no reply exposes an internal rule text", pass: !transcript.some((item) => /[A-Za-z]{4,}/.test(item.text ?? "")) },
    { name: "cancel waits for a card and bare yes confirms it", pass: cancel.kind === "ok" && cancel.pendingCount === 1 && yes?.kind === "ok" && yes.appliedCount === 1 },
    { name: "calls per message <= 1.1", pass: usage.rows[0].calls <= Math.ceil(userMessages * 1.1) },
    { name: "mean input tokens <= 5000", pass: (usage.rows[0].input_tokens ?? 0) <= 5000 },
  ].map((check) => ({ ...check, pass: Boolean(check.pass) }));
  process.stdout.write(
    `${JSON.stringify({ qaRun: "agent-flow-v2", provider: config.aiProvider, model: config.aiModel, usage: usage.rows[0], userMessages, checks, issues: issuesSeen, transcript }, null, 2)}\n`,
  );
  if (checks.some((item) => !item.pass)) process.exitCode = 2;
} finally {
  await database.pool.query("delete from users where id=$1", [userId]).catch(() => undefined);
  const residue = await database.pool.query("select count(*)::int as count from workspaces where id=$1", [workspaceId]).catch(() => ({ rows: [{ count: -1 }] }));
  process.stderr.write(`QA_CLEANUP workspace_residue=${residue.rows[0]?.count ?? -1}\n`);
  await database.onApplicationShutdown();
}
