import test from "node:test";
import assert from "node:assert/strict";
import { canCreateRegistrationInvite, deterministicCopy, guideText, helpText, registrationTokenFromStart } from "../../dist/telegram/telegram-handlers.service.js";
import { telegramLocale } from "../../dist/telegram/telegram-locale.js";
import { TelegramService } from "../../dist/telegram/telegram.service.js";
import { deployedBuildLine, goalsOverviewText, settingsText, taskListKeyboard, tasksOverviewText, todayText } from "../../dist/telegram/telegram-ui.js";
import { groupTaskRows } from "../../dist/core/task-list-view.js";

const config = { aiVoiceMaxBytes: 20 * 1024 * 1024, aiVoiceMaxDurationSeconds: 300, aiMaxMessagesPerHour: 60, aiMaxCallsPerHour: 60 };

test("start and help copy make natural language the primary interface in Russian", () => {
  assert.match(deterministicCopy("ru").ready, /Пиши как человеку/);
  assert.match(deterministicCopy("ru").ready, /голосовое/);
  const help = helpText(config, "ru");
  assert.match(help, /команды для создания задач не нужны/);
  assert.match(help, /голосовое сообщение/);
  assert.match(help, /Кнопка ниже откроет подробности/);
  assert.doesNotMatch(help, /Задачи, цели и чек-листы/);
  assert.doesNotMatch(help, /\/invite/);
  assert.match(help, /\/tasks или \/task/);
  assert.match(help, /Не отправляй в чат пароли/);
});

test("start and help copy are genuinely localized in Ukrainian", () => {
  assert.match(deterministicCopy("uk").ready, /Пиши як людині/);
  assert.match(deterministicCopy("uk").ready, /голосове/);
  const help = helpText(config, "uk");
  assert.match(help, /команди для створення завдань не потрібні/);
  assert.match(help, /голосове повідомлення/);
  assert.match(help, /Кнопка нижче відкриє деталі/);
  assert.doesNotMatch(help, /Завдання, цілі та чеклісти/);
  assert.doesNotMatch(help, /\/invite/);
  assert.match(help, /\/tasks або \/task/);
  assert.match(help, /Не надсилай у чат паролі/);
});

test("English is a first-class locale and primary overview screens do not fall back to Russian", () => {
  assert.equal(telegramLocale(null, "en-US"), "en");
  assert.match(deterministicCopy("en").ready, /For example/);
  assert.match(deterministicCopy("en").ready, /voice message/);
  assert.match(helpText(config, "en"), /voice message/);
  assert.match(helpText(config, "en"), /button below for details/);
  assert.doesNotMatch(helpText(config, "en"), /Tasks, goals, and checklists/);
  assert.doesNotMatch(helpText(config, "en"), /\/invite/);
  const task = { id: "task", title: "Call doctor", importance: "normal", recurrenceRule: null, fuzzyHorizonText: null, timezone: "Europe/Kyiv" };
  const occurrence = {
    id: "occ",
    status: "open",
    timezone: "Europe/Kyiv",
    plannedStartAt: "2026-08-12T09:00:00+03:00",
    plannedEndAt: null,
    plannedLocalDate: null,
    dueAt: null,
    dueLocalDate: null,
  };
  const screens = [
    helpText(config, "en"),
    settingsText(
      {
        timezone: "Europe/Kyiv",
        morningDigestEnabled: false,
        morningReferenceTime: "09:00",
        eveningDigestEnabled: false,
        eveningReferenceTime: "20:00",
        weeklyReviewEnabled: false,
        weeklyReviewWeekday: 7,
        weeklyReviewTime: "20:00",
        quietHoursEnabled: true,
        weekdayQuietStart: "22:00",
        weekdayQuietEnd: "08:00",
      },
      new Date(),
      0,
      "en",
    ),
    tasksOverviewText(groupTaskRows([{ task, occurrence }], "2026-08-12"), { scope: "week", locale: "en" }),
    todayText(groupTaskRows([{ task, occurrence }], "2026-08-12"), "2026-08-12", { locale: "en", staleCount: 2 }),
    goalsOverviewText([{ goal: { id: "g1", title: "Health", status: "active", why: "Feel better", targetLocalDate: null }, tasks: [] }], { scope: "active", locale: "en" }),
  ];
  for (const screen of screens) assert.doesNotMatch(screen, /[А-Яа-яЁёІіЇїЄє]/);
});

test("both lists collapse a repeated task into one line and Today shows its times", () => {
  const recurring = { id: "series", title: "Take medication", importance: "normal", recurrenceRule: "FREQ=DAILY", fuzzyHorizonText: null, timezone: "Europe/Kyiv" };
  const morning = {
    id: "morning",
    status: "open",
    timezone: "Europe/Kyiv",
    plannedStartAt: "2026-08-12T09:00:00+03:00",
    plannedEndAt: null,
    plannedLocalDate: null,
    dueAt: null,
    dueLocalDate: null,
  };
  const evening = { ...morning, id: "evening", plannedStartAt: "2026-08-12T21:00:00+03:00" };
  const rows = [
    { task: recurring, occurrence: morning },
    { task: recurring, occurrence: evening },
  ];

  const groups = groupTaskRows(rows, "2026-08-12");
  assert.equal(groups.length, 1);

  const overview = tasksOverviewText(groups, { scope: "week", locale: "en" });
  assert.equal((overview.match(/Take medication/g) ?? []).length, 1);

  const today = todayText(groups, "2026-08-12", { locale: "en" });
  assert.equal((today.match(/Take medication/g) ?? []).length, 2); // The "Main" line plus the one row.
  assert.match(today, /09:00/);
  assert.match(today, /21:00/);
});

test("task-list keyboard opens each displayed occurrence and can reveal the rest of Today", () => {
  const task = { id: "task", title: "Call doctor", importance: "normal", recurrenceRule: null, fuzzyHorizonText: null, timezone: "Europe/Kyiv" };
  const occurrence = {
    id: "occ",
    status: "open",
    timezone: "Europe/Kyiv",
    plannedStartAt: "2026-08-12T09:00:00+03:00",
    plannedEndAt: null,
    plannedLocalDate: null,
    dueAt: null,
    dueLocalDate: null,
  };
  const groups = groupTaskRows(
    Array.from({ length: 7 }, (_, index) => ({ task: { ...task, id: `task-${index}`, title: `Call doctor ${index}` }, occurrence: { ...occurrence, id: `occ-${index}` } })),
    "2026-08-12",
  );
  const keyboard = taskListKeyboard(groups.slice(0, 6), "en", { source: "tasks", page: 0, pages: 2, rest: 1, pageCallback: (page) => `tsk:week:${page}` });
  const callbacks = keyboard.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes("view:occ:occ-0"));
  assert.ok(callbacks.includes("tsk:week:1"));
});

test("Today presents a same-day fuzzy review honestly instead of hiding it", () => {
  const task = {
    id: "soulmate-scan",
    title: "Пройти Soulmate Scan",
    importance: "normal",
    recurrenceRule: null,
    fuzzyHorizonText: "сегодня вечером",
    reviewAt: "2026-08-23T15:00:00Z",
    timezone: "Europe/Kyiv",
  };

  const text = todayText(groupTaskRows([{ task, occurrence: null }], "2026-08-23"), "2026-08-23", { locale: "ru" });

  assert.match(text, /Пройти Soulmate Scan/);
  assert.match(text, /пересмотреть в 18:00/);
});

test("registration deep links and invitation authority stay deterministic", async () => {
  const token = "A".repeat(43);
  assert.equal(registrationTokenFromStart(`/start join_${token}`), token);
  assert.equal(registrationTokenFromStart(`/start join_${token} extra`), null);
  assert.equal(registrationTokenFromStart("/start hello"), null);
  assert.equal(canCreateRegistrationInvite(42, 42), true);
  assert.equal(canCreateRegistrationInvite(42, 7), false);
  assert.equal(canCreateRegistrationInvite(undefined, 42), false);

  const telegram = Object.create(TelegramService.prototype);
  telegram.bot = { api: { getMe: async () => ({ username: "IPsychoTestBot" }) } };
  assert.equal(await telegram.registrationLink(token), `https://t.me/IPsychoTestBot?start=join_${token}`);
  telegram.bot = { api: { getMe: async () => ({ username: undefined }) } };
  await assert.rejects(() => telegram.registrationLink(token), /username/i);
});

test("guide pages explain reports and external AI processing without exposing sensitive capabilities", () => {
  const reports = guideText("reports", "ru");
  assert.match(reports, /Утренний обзор/);
  assert.match(reports, /Еженедельный обзор/);
  const ai = guideText("ai", "en");
  assert.match(ai, /requires consent/);
  assert.match(ai, /cannot access other users/);
  assert.match(guideText("goals", "uk"), /щотижневому огляді/);
});

test("status reports the deployed build so a deploy can be verified from Telegram", () => {
  assert.equal(deployedBuildLine("ddaba510e6feb22f67f3130d16501a039284a73d", "ru"), "🏷 Сборка: ddaba51");
  assert.equal(deployedBuildLine("ddaba510e6feb22f67f3130d16501a039284a73d", "uk"), "🏷 Збірка: ddaba51");
  assert.equal(deployedBuildLine("ddaba510e6feb22f67f3130d16501a039284a73d", "en"), "🏷 Build: ddaba51");
  assert.match(deployedBuildLine(undefined, "ru"), /неизвестна/);
});
