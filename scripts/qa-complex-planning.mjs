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
import { TaskBatchRepository } from "../dist/actions/task-batch.repository.js";
import { ActionsService } from "../dist/actions/actions.service.js";
import { ReminderSchedulingService } from "../dist/reminders/reminder-scheduling.service.js";
import { BriefingContentService } from "../dist/briefings/briefing-content.service.js";
import { ChatService } from "../dist/chat/chat.service.js";
import { localDateAndTimeToUtc, localDateAt, shiftLocalDate } from "../dist/core/timezone.js";

const config = { ...loadConfig(process.env), taskBatchEnabled: true };
const database = new DatabaseService(config);
const provider = config.aiProvider === "openai" ? new OpenAiProvider(config)
  : config.aiProvider === "gemini" ? new GeminiProvider(config) : new DeepSeekProvider(config);
const aiRepository = new AiRepository(database);
const ai = new AiService(config, provider, aiRepository);
const messages = new MessagesRepository(database);
const queue = { enqueue: async () => undefined };
const recurrence = new RecurrenceMaintenanceService(database, queue);
const tasks = new TasksService(new TasksRepository(database), queue, recurrence);
const settings = new SettingsService(database);
const contextRepository = new ContextRepository(database);
const context = new ContextService(contextRepository, settings);
const actionsRepository = new ActionsRepository(database);
const taskBatches = new TaskBatchRepository(database);
const reminders = new ReminderSchedulingService(database, queue);
const actions = new ActionsService(
  actionsRepository,
  new ActionMutationsRepository(database),
  tasks,
  reminders,
  context,
  new ContextActionsRepository(database),
  settings,
  taskBatches,
  config,
);
const chat = new ChatService(ai, actions, messages, tasks, context, new BriefingContentService(database));

const userId = randomUUID();
const workspaceId = randomUUID();
const goalA = randomUUID();
const goalB = randomUUID();
const telegramId = BigInt(`8${String(Date.now()).slice(-14)}`);
const timezone = "Europe/Kyiv";
const today = localDateAt(new Date(), timezone);
const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
const monday = shiftLocalDate(today, ((8 - weekday) % 7) || 7);
const wednesday = shiftLocalDate(monday, 2);
const transcript = [];
let telegramMessageId = 7_000_000;

function pointDefinition(date, time, kind = "task") {
  const start = localDateAndTimeToUtc(date, time, timezone).date;
  return {
    kind, importance: "normal", timeMode: "point", timezone,
    plannedStartAt: start, habitMode: false,
  };
}

async function record(result) {
  transcript.push(result);
  if (result.kind === "ok") {
    telegramMessageId += 1;
    await chat.recordAssistantMessage({
      workspaceId, userId, content: result.text, telegramChatId: Number(telegramId), telegramMessageId,
      ...(result.topicId ? { topicId: result.topicId } : {}),
    });
  }
  return result;
}

async function send(text, reviewTopicId) {
  telegramMessageId += 1;
  const result = await chat.processText({
    workspaceId, userId, aiStatus: "enabled", timezone, language: "ru", text,
    telegramChatId: Number(telegramId), telegramMessageId,
    ...(reviewTopicId ? { review: "weekly", reviewTopicId } : {}),
  });
  return record({ label: text, ...result });
}

function assertion(name, pass, evidence) {
  return { name, pass: Boolean(pass), evidence };
}

try {
  await database.pool.query("insert into users(id, telegram_user_id) values ($1,$2)", [userId, telegramId]);
  await database.pool.query("insert into workspaces(id, owner_user_id) values ($1,$2)", [workspaceId, userId]);
  await database.pool.query("insert into workspace_members(workspace_id,user_id,role) values ($1,$2,'owner')", [workspaceId, userId]);
  await database.pool.query("insert into user_settings(user_id,timezone,digest_timezone,quiet_hours_timezone) values ($1,$2,$2,$2)", [userId, timezone]);
  await database.pool.query("insert into goals(id,workspace_id,created_by_user_id,title,why) values ($1,$3,$4,'Запуск консультационной практики','Получить первых платных клиентов'),($2,$3,$4,'Переход в новую компанию','Найти более подходящую роль')", [goalA, goalB, workspaceId, userId]);
  await ai.grantConsent(userId);

  const seeded = await tasks.createTasks([
    { workspaceId, actorUserId: userId, recipientUserId: userId, title: "Отправить пять приглашений потенциальным клиентам", definition: pointDefinition(monday, "09:00"), why: "Проверить спрос", nextAction: "Выбрать первые пять контактов" },
    { workspaceId, actorUserId: userId, recipientUserId: userId, title: "Вечернее интервью с продуктовой компанией", definition: pointDefinition(wednesday, "19:00", "event"), why: "Оценить новую роль", context: "Вечером энергия обычно ниже" },
  ]);
  await database.pool.query("insert into task_goals(workspace_id,task_id,goal_id,source,confidence) values ($1,$2,$3,'user_explicit',1)", [workspaceId, seeded[0].taskId, goalA]);

  const opening = await record({ label: "START_WEEKLY", ...(await chat.startReview({ workspaceId, userId, aiStatus: "enabled", timezone, digestTimezone: timezone, language: "ru", kind: "weekly" })) });
  const topicId = opening.kind === "ok" ? opening.topicId : undefined;
  if (!topicId) throw new Error("weekly review did not create a topic");
  const outcome = await send("На следующей неделе хочу получить две оплаченные диагностические сессии.", topicId);
  const capacity = await send("Реально есть шесть часов: утром я собран, после 18:00 быстро устаю. В среду вечером уже назначено интервью.", topicId);
  const risks = await send("Главный риск — снова потратить всё время на улучшение презентации вместо разговоров с людьми.", topicId);
  const finalPlan = await send("Минимум недели — пять приглашений и одна проведённая сессия. Обязательства: интервью в среду и семейный вечер в пятницу. Дай конкретный финальный план сейчас, расписание пока не меняй.", topicId);

  const ambiguous = await send("Скажи честно, что сейчас слабее всего в моей цели и что отложить?");
  const focused = await send("Проанализируй именно цель «Запуск консультационной практики»: выбери максимум три приоритета, назови что отложить и какие твои предположения стоит проверить.");
  const packageResult = await send(`Сделай одним пакетом: создай на ${monday} в 11:00 задачу подготовить короткий оффер, создай на ${wednesday} в 10:00 задачу написать десяти контактам и свяжи обе с целью «Запуск консультационной практики». Интервью перенеси со среды 19:00 на четверг 17:00, потому что вечером у меня мало энергии.`);

  let packageApplied = packageResult.kind === "ok" ? packageResult.appliedGroupId : undefined;
  if (packageResult.kind === "ok" && packageResult.pendingGroupId) {
    const confirmed = await actions.confirm(workspaceId, userId, userId, packageResult.pendingGroupId, new Date());
    packageApplied = confirmed.groupId;
    transcript.push({ label: "CONFIRM_PACKAGE", kind: "confirmed", ...confirmed });
  }
  if (packageApplied) {
    await actions.undo(workspaceId, userId, packageApplied, new Date());
    transcript.push({ label: "UNDO_PACKAGE", kind: "undone", groupId: packageApplied });
  }

  const finalText = finalPlan.kind === "ok" ? finalPlan.text.toLowerCase() : "";
  const focusedText = focused.kind === "ok" ? focused.text.toLowerCase() : "";
  const checks = [
    assertion("outcome-only turn continues weekly review", outcome.kind === "ok" && outcome.review?.completed === false && Boolean(outcome.text), outcome.kind),
    assertion("final plan references existing outreach", /приглаш|контакт/.test(finalText), finalPlan.kind),
    assertion("final plan notices evening interview or energy conflict", /интервью|вечер|энерг/.test(finalText), finalPlan.kind),
    assertion("advisory weekly plan creates no actions", finalPlan.kind === "ok" && finalPlan.appliedCount === 0 && finalPlan.pendingCount === 0, finalPlan.kind),
    assertion("ambiguous goal advice does not mutate", ambiguous.kind === "ok" && ambiguous.appliedCount === 0 && ambiguous.pendingCount === 0, ambiguous.kind),
    assertion("focused advice states priorities/deferrals/hypotheses", /приоритет|отлож|гипотез|предполож/.test(focusedText), focused.kind),
    assertion("mixed natural-language package is accepted", packageResult.kind === "ok" && Boolean(packageApplied), packageResult.kind),
    assertion("mixed package is undoable", transcript.some((item) => item.label === "UNDO_PACKAGE"), packageApplied ?? null),
  ];
  process.stdout.write(`${JSON.stringify({ qaRun: "complex-planning-weekly", provider: config.aiProvider, model: config.aiModel, fixtures: { monday, wednesday }, checks, transcript }, null, 2)}\n`);
  if (checks.some((item) => !item.pass)) process.exitCode = 2;
} finally {
  await database.pool.query("delete from users where id=$1", [userId]).catch(() => undefined);
  const residue = await database.pool.query("select count(*)::int as count from workspaces where id=$1", [workspaceId]).catch(() => ({ rows: [{ count: -1 }] }));
  process.stderr.write(`QA_CLEANUP workspace_residue=${residue.rows[0]?.count ?? -1}\n`);
  await database.onApplicationShutdown();
}
