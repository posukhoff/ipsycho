/**
 * Replays the dialog set in tests/eval/dialogs.json against the live provider and checks what the
 * server actually stored: task rows, occurrences, reminder deliveries, goal links, memory and
 * settings. Not "applied > 0" — a wrong task that applies cleanly is still a failure.
 *
 * Usage:
 *   node scripts/eval-agent.mjs [--runs 1] [--only id,id] [--baseline eval/baseline.json] [--out eval/results]
 *
 * Needs DATABASE_URL, the AI_* variables and a built dist/. Each case gets its own throwaway
 * workspace, deleted afterwards. The exit code is 2 when a check fails, 3 when a baseline regresses.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { ContextService } from "../dist/context/context.service.js";
import { SettingsService } from "../dist/settings/settings.service.js";
import { SettingsRepository } from "../dist/settings/settings.repository.js";
import { ActionsRepository } from "../dist/actions/actions.repository.js";
import { ActionGroupRepository } from "../dist/actions/action-group.repository.js";
import { ActionsService } from "../dist/actions/actions.service.js";
import { ReminderSchedulingService } from "../dist/reminders/reminder-scheduling.service.js";
import { BriefingContentService } from "../dist/briefings/briefing-content.service.js";
import { TurnContextService } from "../dist/chat/turn-context.service.js";
import { ChatService } from "../dist/chat/chat.service.js";
import { localDateAt, localDateTimeAt } from "../dist/core/timezone.js";

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(process.env);
const database = new DatabaseService(config);
const provider = config.aiProvider === "openai" ? new OpenAiProvider(config) : config.aiProvider === "gemini" ? new GeminiProvider(config) : new DeepSeekProvider(config);
const ai = new AiService(config, provider, new AiRepository(database));
const messages = new MessagesRepository(database);
const queue = { enqueue: async () => undefined };
const recurrence = new RecurrenceMaintenanceService(database, queue);
const tasksRepository = new TasksRepository(database);
const tasks = new TasksService(tasksRepository, queue, recurrence);
const settings = new SettingsService(new SettingsRepository(database));
const contextRepository = new ContextRepository(database);
const context = new ContextService(contextRepository);
const reminders = new ReminderSchedulingService(database, queue);
const briefings = new BriefingContentService(database);
const actions = new ActionsService(new ActionsRepository(database), new ActionGroupRepository(database), tasks, reminders, context, settings);
const turnContext = new TurnContextService(tasks, contextRepository, settings, briefings);
const chat = new ChatService(ai, actions, messages, turnContext, context);

const TIMEZONE = "Europe/Kyiv";
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const dialogs = JSON.parse(readFileSync("tests/eval/dialogs.json", "utf8"));
const selected = args.only ? dialogs.cases.filter((item) => args.only.includes(item.id)) : dialogs.cases;
if (!selected.length) throw new Error("no cases selected");

const runs = [];
for (let run = 0; run < args.runs; run += 1) {
  for (const dialog of selected) runs.push(await evaluate(dialog, run));
}

const byCase = new Map();
for (const result of runs) {
  const bucket = byCase.get(result.id) ?? { id: result.id, runs: 0, passed: 0, failures: [] };
  bucket.runs += 1;
  if (result.pass) bucket.passed += 1;
  else bucket.failures.push(...result.failed);
  byCase.set(result.id, bucket);
}
const usage = await usageTotals();
const summary = {
  startedAt: new Date().toISOString(),
  provider: config.aiProvider,
  model: config.aiModel,
  runs: args.runs,
  cases: [...byCase.values()].map((item) => ({ ...item, passRate: Number((item.passed / item.runs).toFixed(3)), failures: [...new Set(item.failures)] })),
  passRate: Number((runs.filter((item) => item.pass).length / runs.length).toFixed(3)),
  usage,
  details: runs,
};

mkdirSync(args.out, { recursive: true });
const file = join(args.out, `${new Date().toISOString().slice(0, 10)}-${config.aiModel.replace(/[^\w.-]/gu, "_")}.json`);
writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...summary, details: undefined }, null, 2)}\n`);
process.stderr.write(`eval_written ${file}\n`);

let exitCode = summary.cases.every((item) => item.passRate === 1) ? 0 : 2;
if (args.baseline) {
  const baseline = JSON.parse(readFileSync(args.baseline, "utf8"));
  const previous = new Map(baseline.cases.map((item) => [item.id, item.passRate]));
  const regressions = summary.cases.filter((item) => item.passRate < (previous.get(item.id) ?? 0));
  if (regressions.length) {
    process.stderr.write(`eval_regression ${regressions.map((item) => `${item.id}:${previous.get(item.id)}→${item.passRate}`).join(" ")}\n`);
    exitCode = 3;
  }
}
await database.onApplicationShutdown();
process.exitCode = exitCode;

async function evaluate(dialog, run) {
  const scope = await fixture(dialog);
  const started = Date.now();
  try {
    for (const seed of dialog.seed ?? []) {
      const seeded = await send(scope, seed, dialog.language);
      if (seeded.kind === "ok" && seeded.pendingGroupId) {
        await actions.confirm(scope.workspaceId, scope.userId, scope.userId, seeded.pendingGroupId).catch(() => undefined);
      }
    }
    const before = await snapshot(scope);
    const callsBefore = await providerCalls(scope);
    const result = await send(scope, dialog.message, dialog.language);
    const calls = (await providerCalls(scope)) - callsBefore;
    let after = await snapshot(scope);
    let followUp = null;
    if (dialog.then) {
      followUp = await send(scope, dialog.then.message, dialog.language);
      after = await snapshot(scope);
    }
    const failed = [
      ...checkExpectations(dialog.expect, { result, calls, before, after, scope }),
      ...(dialog.then ? checkExpectations(dialog.then.expect, { result: followUp, calls: 1, before, after, scope }).map((item) => `then:${item}`) : []),
    ];
    return {
      id: dialog.id,
      run,
      pass: failed.length === 0,
      failed,
      calls,
      elapsedMs: Date.now() - started,
      reply: result.kind === "ok" ? result.text : result.kind,
      applied: result.kind === "ok" ? result.appliedCount : 0,
      pending: result.kind === "ok" ? result.pendingCount : 0,
    };
  } catch (error) {
    return { id: dialog.id, run, pass: false, failed: [`threw: ${error instanceof Error ? error.message : String(error)}`], calls: 0, elapsedMs: Date.now() - started };
  } finally {
    await database.pool.query("delete from users where id=$1", [scope.userId]).catch(() => undefined);
  }
}

/** Every check names the stored fact it read, so a failure says what the server has, not what the model said. */
function checkExpectations(expect, ctx) {
  if (!expect) return [];
  const failed = [];
  const { result, calls, before, after } = ctx;
  const ok = result.kind === "ok";
  const createdTasks = after.tasks.filter((task) => !before.tasks.some((old) => old.id === task.id));
  const fail = (name, detail) => failed.push(`${name} (${detail})`);

  if (expect.settles && !(ok && (result.appliedCount > 0 || result.pendingCount > 0)))
    fail("settles", `kind=${result.kind} applied=${ok ? result.appliedCount : 0} pending=${ok ? result.pendingCount : 0}`);
  if (expect.maxProviderCalls !== undefined && calls > expect.maxProviderCalls) fail("maxProviderCalls", `${calls} > ${expect.maxProviderCalls}`);
  if (expect.applied !== undefined && (ok ? result.appliedCount : 0) !== expect.applied) fail("applied", `${ok ? result.appliedCount : 0} ≠ ${expect.applied}`);
  if (expect.pending !== undefined && (ok ? result.pendingCount : 0) !== expect.pending) fail("pending", `${ok ? result.pendingCount : 0} ≠ ${expect.pending}`);
  if (expect.tasksCreated !== undefined && createdTasks.length !== expect.tasksCreated) fail("tasksCreated", `${createdTasks.length} ≠ ${expect.tasksCreated}`);
  if (expect.questionExpected !== undefined) {
    const asked = ok && /[?？]/u.test(result.text ?? "");
    if (asked !== expect.questionExpected) fail("questionExpected", `asked=${asked}`);
  }
  if (expect.titleMatches && !createdTasks.some((task) => task.title.toLowerCase().includes(expect.titleMatches.toLowerCase()))) {
    fail("titleMatches", createdTasks.map((task) => task.title).join(" | ") || "no task");
  }
  if (expect.memoriesSaved !== undefined && after.memory - before.memory !== expect.memoriesSaved)
    fail("memoriesSaved", `${after.memory - before.memory} ≠ ${expect.memoriesSaved}`);
  if (expect.goalLinks !== undefined && after.goalLinks - before.goalLinks !== expect.goalLinks) fail("goalLinks", `${after.goalLinks - before.goalLinks} ≠ ${expect.goalLinks}`);
  if (expect.reminderCount !== undefined) {
    const added = after.reminders - before.reminders;
    if (added < expect.reminderCount) fail("reminderCount", `${added} < ${expect.reminderCount}`);
  }
  if (expect.occurrencesRescheduled !== undefined && after.rescheduleEvents - before.rescheduleEvents !== expect.occurrencesRescheduled) {
    fail("occurrencesRescheduled", `${after.rescheduleEvents - before.rescheduleEvents} ≠ ${expect.occurrencesRescheduled}`);
  }
  if (expect.occurrencesDone !== undefined && after.doneOccurrences - before.doneOccurrences !== expect.occurrencesDone) {
    fail("occurrencesDone", `${after.doneOccurrences - before.doneOccurrences} ≠ ${expect.occurrencesDone}`);
  }
  if (expect.tasksCancelled !== undefined && after.cancelledTasks - before.cancelledTasks !== expect.tasksCancelled) {
    fail("tasksCancelled", `${after.cancelledTasks - before.cancelledTasks} ≠ ${expect.tasksCancelled}`);
  }
  if (expect.habitTasks !== undefined && createdTasks.filter((task) => task.habit_mode).length !== expect.habitTasks) {
    fail("habitTasks", `${createdTasks.filter((task) => task.habit_mode).length} ≠ ${expect.habitTasks}`);
  }
  if (expect.recurrenceMatches && !createdTasks.some((task) => (task.recurrence_rule ?? "").includes(expect.recurrenceMatches))) {
    fail("recurrenceMatches", createdTasks.map((task) => task.recurrence_rule).join(" | ") || "none");
  }
  if (expect.recurrenceEnds && !createdTasks.some((task) => task.recurrence_end_local_date)) fail("recurrenceEnds", "no end date stored");
  if (expect.exclusions !== undefined && after.exclusions - before.exclusions !== expect.exclusions)
    fail("exclusions", `${after.exclusions - before.exclusions} ≠ ${expect.exclusions}`);
  if (expect.hasLocalDateOnly && !createdTasks.some((task) => task.planned_local_date && !task.planned_start_at)) {
    fail("hasLocalDateOnly", createdTasks.map((task) => `${task.planned_local_date}/${task.planned_start_at}`).join(" | ") || "none");
  }
  if (expect.settingsChanged && after.settings.version === before.settings.version) fail("settingsChanged", `version unchanged (${expect.settingsChanged})`);
  if (expect.timezone && after.settings.timezone !== expect.timezone) fail("timezone", `${after.settings.timezone} ≠ ${expect.timezone}`);
  if (expect.replyMentions && !(ok && (result.text ?? "").toLowerCase().includes(expect.replyMentions.toLowerCase()))) fail("replyMentions", expect.replyMentions);
  if (expect.replyLanguage && ok) {
    const text = result.text ?? "";
    const looksCyrillic = /[а-яіїєґ]/iu.test(text);
    if (expect.replyLanguage === "en" && looksCyrillic) fail("replyLanguage", "expected English, got Cyrillic");
    if (expect.replyLanguage === "uk" && /[ыэё]|Записал|Отметил|Перенёс|Отменил/u.test(text)) fail("replyLanguage", `expected Ukrainian, got «${text.slice(0, 40)}»`);
  }

  const occurrences = after.occurrences.filter((row) => createdTasks.some((task) => task.id === row.task_id));
  const starts = occurrences.map((row) => row.planned_start_at).filter(Boolean);
  if (expect.startLocalTime) {
    const times = starts.map((value) => wallTime(value));
    if (!times.includes(expect.startLocalTime)) fail("startLocalTime", times.join(" | ") || "no planned start");
  }
  if (expect.startNotBeforeLocalTime) {
    // A constraint, not a demand to schedule: nothing created breaks nothing.
    const times = starts.map((value) => wallTime(value));
    if (times.some((time) => time < expect.startNotBeforeLocalTime)) fail("startNotBeforeLocalTime", times.join(" | "));
  }
  if (expect.startOffsetDays !== undefined) {
    const today = localDateAt(new Date(), TIMEZONE);
    const days = starts.map((value) => Math.round((Date.parse(localDateAt(new Date(value), TIMEZONE)) - Date.parse(today)) / 86_400_000));
    const dates = occurrences.map((row) => row.planned_local_date).filter(Boolean);
    const localDays = dates.map((value) => Math.round((Date.parse(String(value).slice(0, 10)) - Date.parse(today)) / 86_400_000));
    if (![...days, ...localDays].includes(expect.startOffsetDays)) fail("startOffsetDays", [...days, ...localDays].join(" | ") || "none");
  }
  if (expect.startWithinHours) {
    const [min, max] = expect.startWithinHours;
    const hours = starts.map((value) => (new Date(value).getTime() - Date.now()) / 3_600_000);
    if (!hours.some((value) => value >= min && value <= max)) fail("startWithinHours", hours.map((value) => value.toFixed(2)).join(" | ") || "none");
  }
  if (expect.durationMinutes !== undefined) {
    const durations = occurrences
      .filter((row) => row.planned_start_at && row.planned_end_at)
      .map((row) => (new Date(row.planned_end_at).getTime() - new Date(row.planned_start_at).getTime()) / 60_000);
    if (!durations.includes(expect.durationMinutes)) fail("durationMinutes", durations.join(" | ") || "no window");
  }
  if (expect.weekday) {
    const days = occurrences.map((row) =>
      row.planned_start_at
        ? WEEKDAYS[new Date(row.planned_start_at).getUTCDay()]
        : row.planned_local_date
          ? WEEKDAYS[new Date(`${String(row.planned_local_date).slice(0, 10)}T12:00:00Z`).getUTCDay()]
          : null,
    );
    if (!days.includes(expect.weekday)) fail("weekday", days.join(" | ") || "none");
  }
  return failed;
}

function wallTime(value) {
  const local = localDateTimeAt(new Date(value), TIMEZONE);
  return `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
}

async function fixture(dialog) {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const telegramId = BigInt(`8${String(Date.now()).slice(-11)}${String(Math.floor(Math.random() * 900) + 100)}`);
  await database.pool.query("insert into users(id, telegram_user_id) values ($1,$2)", [userId, telegramId]);
  await database.pool.query("insert into workspaces(id, owner_user_id) values ($1,$2)", [workspaceId, userId]);
  await database.pool.query("insert into workspace_members(workspace_id,user_id,role) values ($1,$2,'owner')", [workspaceId, userId]);
  await database.pool.query("insert into user_settings(user_id,timezone,digest_timezone,quiet_hours_timezone) values ($1,$2,$2,$2)", [userId, TIMEZONE]);
  if (dialog.seedGoal) {
    await database.pool.query("insert into goals(id,workspace_id,created_by_user_id,title,why) values ($1,$2,$3,$4,'Проверить спрос без выгорания')", [
      randomUUID(),
      workspaceId,
      userId,
      dialog.seedGoal,
    ]);
  }
  for (const content of dialog.seedMemory ?? []) {
    await database.pool.query("insert into memory_items(id,workspace_id,user_id,type,content,sensitive,source) values ($1,$2,$3,'context',$4,false,'user_explicit')", [
      randomUUID(),
      workspaceId,
      userId,
      content,
    ]);
  }
  await ai.grantConsent(userId);
  return { userId, workspaceId, telegramId: Number(telegramId), messageId: 7_000_000 };
}

async function send(scope, text, language) {
  scope.messageId += 1;
  const result = await chat.processText({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    aiStatus: "enabled",
    timezone: TIMEZONE,
    language: language ?? "ru",
    text,
    telegramChatId: scope.telegramId,
    telegramMessageId: scope.messageId,
  });
  if (result.kind === "ok" && !result.skipAssistantHistory) {
    scope.messageId += 1;
    await chat.recordAssistantMessage({
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      content: result.text,
      telegramChatId: scope.telegramId,
      telegramMessageId: scope.messageId,
      ...(result.topicId ? { topicId: result.topicId } : {}),
      ...(result.pendingGroupId ? { pendingGroupId: result.pendingGroupId } : {}),
    });
  }
  return result;
}

async function snapshot(scope) {
  const [tasksRows, occurrences, counters, settingsRow] = await Promise.all([
    database.pool.query("select id, title, status, habit_mode, recurrence_rule, recurrence_end_local_date, planned_local_date, planned_start_at from tasks where workspace_id=$1", [
      scope.workspaceId,
    ]),
    database.pool.query("select task_id, status, planned_start_at, planned_end_at, planned_local_date, due_at from task_occurrences where workspace_id=$1", [scope.workspaceId]),
    database.pool.query(
      `select
         (select count(*) from memory_items where workspace_id=$1)::int as memory,
         (select count(*) from task_goals where workspace_id=$1)::int as goal_links,
         (select count(*) from reminder_deliveries where workspace_id=$1)::int as reminders,
         (select count(*) from task_recurrence_exclusions where workspace_id=$1)::int as exclusions,
         (select count(*) from task_events where workspace_id=$1 and event_type='occurrence:rescheduled')::int as reschedule_events,
         (select count(*) from task_occurrences where workspace_id=$1 and status='done')::int as done_occurrences,
         (select count(*) from tasks where workspace_id=$1 and status='cancelled')::int as cancelled_tasks`,
      [scope.workspaceId],
    ),
    database.pool.query("select version, timezone from user_settings where user_id=$1", [scope.userId]),
  ]);
  const row = counters.rows[0];
  return {
    tasks: tasksRows.rows,
    occurrences: occurrences.rows,
    memory: row.memory,
    goalLinks: row.goal_links,
    reminders: row.reminders,
    exclusions: row.exclusions,
    rescheduleEvents: row.reschedule_events,
    doneOccurrences: row.done_occurrences,
    cancelledTasks: row.cancelled_tasks,
    settings: settingsRow.rows[0] ?? { version: 0, timezone: TIMEZONE },
  };
}

async function providerCalls(scope) {
  const { rows } = await database.pool.query("select coalesce(sum(attempts),0)::int as calls from ai_usage where user_id=$1", [scope.userId]);
  return rows[0].calls;
}

async function usageTotals() {
  const { rows } = await database.pool.query(
    "select count(*)::int as rows, coalesce(sum(attempts),0)::int as attempts, round(avg(input_tokens))::int as mean_input_tokens, round(sum(estimated_cost_usd), 4)::text as usd from ai_usage where created_at > now() - interval '2 hours'",
  );
  return rows[0];
}

function parseArgs(argv) {
  const parsed = { runs: 1, out: "eval/results", baseline: null, only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--runs") parsed.runs = Number(value);
    else if (flag === "--out") parsed.out = value;
    else if (flag === "--baseline") parsed.baseline = value;
    else if (flag === "--only") parsed.only = value.split(",");
    else continue;
    index += 1;
  }
  if (!Number.isInteger(parsed.runs) || parsed.runs < 1) throw new Error("--runs must be a positive integer");
  return parsed;
}
