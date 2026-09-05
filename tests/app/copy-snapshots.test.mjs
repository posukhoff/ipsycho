import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { deterministicCopy, guideText, helpText } from "../../dist/telegram/telegram-handlers.service.js";
import {
  goalDetailText,
  goalsOverviewText,
  reminderCardText,
  remindersText,
  settingsText,
  taskCardText,
  pausedSeriesText,
  weekPlanText,
  taskGroupText,
  tasksOverviewText,
  terminalTaskText,
  todayText,
} from "../../dist/telegram/telegram-ui.js";
import { groupTaskRows } from "../../dist/core/task-list-view.js";
import { renderAppliedReport } from "../../dist/core/applied-report.js";

/**
 * One golden file per locale. Any change to user-facing copy shows up as a diff a reviewer reads
 * in full, in all three languages at once, instead of as a regex that still passes while the
 * sentence around it changed. Refresh with UPDATE_COPY_SNAPSHOTS=1 npm run test:app.
 */
const NOW = new Date("2026-09-04T09:00:00Z");
const TIMEZONE = "Europe/Kyiv";
const config = { aiVoiceMaxBytes: 20 * 1024 * 1024, aiVoiceMaxDurationSeconds: 300, aiMaxMessagesPerHour: 60, aiMaxCallsPerHour: 60 };

const task = {
  title: "Позвонить клиенту",
  importance: "required",
  kind: "task",
  timezone: TIMEZONE,
  why: "Объяснить ошибку и предложить два решения.",
  nextAction: "Подготовить список вариантов",
  checklist: [
    { text: "Собрать факты", done: true },
    { text: "Написать письмо", done: false },
  ],
  goalTitle: "Запустить первую платную группу",
  nextReminderAt: new Date("2026-09-05T07:20:00Z"),
};
const occurrence = {
  id: "11111111-1111-1111-1111-111111111111",
  status: "open",
  timezone: TIMEZONE,
  plannedStartAt: new Date("2026-09-05T07:30:00Z"),
  plannedEndAt: null,
  plannedLocalDate: null,
  dueAt: null,
  dueLocalDate: null,
  overdue: false,
};
const settings = {
  timezone: TIMEZONE,
  morningDigestEnabled: true,
  morningReferenceTime: "08:30",
  eveningDigestEnabled: false,
  eveningReferenceTime: "21:00",
  weeklyReviewEnabled: true,
  weeklyReviewWeekday: 7,
  weeklyReviewTime: "18:00",
  quietHoursEnabled: true,
  weekdayQuietStart: "22:00",
  weekdayQuietEnd: "08:00",
  weekendQuietStart: "23:00",
  weekendQuietEnd: "09:00",
  pinnedLanguage: null,
  notificationsSnoozedUntil: null,
};
const report = [
  {
    kind: "task_created",
    title: "Позвонить клиенту",
    timezone: TIMEZONE,
    importance: "required",
    recurring: false,
    schedule: { timezone: TIMEZONE, plannedStartAt: new Date("2026-09-05T07:30:00Z"), plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null },
    fuzzyHorizonText: null,
    reminderAt: new Date("2026-09-05T07:20:00Z"),
    goalTitle: "Запустить первую платную группу",
  },
  { kind: "occurrence", title: "Полить цветы", operation: "done" },
  { kind: "settings", operation: "quiet_hours" },
];

const LOCAL_DATE = "2026-09-04";
const listRow = { task: { ...task, id: "t1" }, occurrence };
// One task on three dates: what the list must collapse into a single line.
const repeatedRows = ["2026-09-06", "2026-09-09", "2026-09-11"].map((date, index) => ({
  task: { id: `r${index}`, title: "Позвонить маме", importance: "normal", timezone: TIMEZONE },
  occurrence: { id: `00000000-0000-0000-0000-00000000000${index}`, status: "open", timezone: TIMEZONE, plannedStartAt: new Date(`${date}T09:00:00Z`), overdue: false },
}));

const GOAL = {
  goal: { id: "g1", title: "Запустить первую платную группу", status: "active", why: "Проверить спрос", targetLocalDate: "2026-12-01" },
  tasks: [{ id: "t1", title: "Позвонить клиенту", nextAction: "Подготовить список", context: null, dueLocalDate: "2026-09-05" }],
};
// Two reminders for one task in a day collapse into one line; the next day gets its own heading.
const REMINDERS = [
  { delivery: { id: "d1", scheduledFor: new Date("2026-09-04T06:00:00Z") }, task: { title: "Позвонить клиенту", timezone: TIMEZONE } },
  { delivery: { id: "d2", scheduledFor: new Date("2026-09-04T15:00:00Z") }, task: { title: "Позвонить клиенту", timezone: TIMEZONE } },
  { delivery: { id: "d3", scheduledFor: new Date("2026-09-05T06:00:00Z") }, task: { title: "Полить цветы", timezone: TIMEZONE } },
  { delivery: { id: "d4", scheduledFor: new Date("2026-09-09T06:00:00Z") }, task: { title: "Полить цветы", timezone: TIMEZONE } },
];

const GUIDE_SECTIONS = ["tasks", "goals", "reminders", "reports", "ai"];

function render(locale) {
  const copy = deterministicCopy(locale);
  const sections = [
    ["start", copy.ready],
    ["onboarding: timezone", copy.startOnboarding],
    ["help", helpText(config, locale)],
    // Every guide section, because `guideText(locale)` used to pin the literal string "undefined":
    // the function takes the section first, so the whole in-product guide had no coverage at all.
    ...GUIDE_SECTIONS.map((section) => [`guide: ${section}`, guideText(section, locale)]),
    ["settings", settingsText(settings, NOW, 42, locale)],
    ["today", todayText(groupTaskRows([listRow], LOCAL_DATE), LOCAL_DATE, { locale, completedCount: 2, staleCount: 3, now: NOW })],
    ["tasks", tasksOverviewText(groupTaskRows([listRow, ...repeatedRows], LOCAL_DATE), { scope: "week", locale, now: NOW })],
    [
      "week plan",
      weekPlanText(
        [
          { title: "Разобраться с налогами", importance: "required", pickedWeekStart: "2026-08-31" },
          { title: "Привести в порядок машину", importance: "normal", pickedWeekStart: "2026-09-07" },
          { title: "Подготовиться к собеседованию", importance: "normal", pickedWeekStart: null },
        ],
        { locale, todayLocalDate: "2026-09-09", total: 3, summary: { done: 4, takenNotStarted: 1 } },
      ),
    ],
    ["paused series", pausedSeriesText([{ title: "Полить цветы", recurrenceRule: "FREQ=WEEKLY;BYDAY=MO", recurrenceEndLocalDate: null }], { locale, total: 3, offset: 8 })],
    ["task group", taskGroupText(groupTaskRows(repeatedRows, LOCAL_DATE)[0], locale, NOW)],
    ["goals", goalsOverviewText([GOAL], { scope: "active", locale })],
    ["goal", goalDetailText(GOAL, locale)],
    ["reminders", remindersText(REMINDERS, { locale, timezone: TIMEZONE, now: NOW })],
    ["task card", taskCardText(task, occurrence, NOW, locale)],
    ["reminder card", reminderCardText({ task, occurrence, purpose: "user_reminder", now: NOW, locale })],
    ["terminal card", terminalTaskText(task, "done", NOW, locale)],
    ["applied report", renderAppliedReport(report, NOW, locale)],
  ];
  return sections.map(([name, text]) => `### ${name}\n${text}`).join("\n\n");
}

for (const locale of ["ru", "uk", "en"]) {
  test(`user-facing copy in ${locale} matches its snapshot`, () => {
    const file = new URL(`./__snapshots__/copy.${locale}.txt`, import.meta.url);
    const rendered = `${render(locale)}\n`;
    if (process.env.UPDATE_COPY_SNAPSHOTS) {
      writeFileSync(file, rendered);
      return;
    }
    assert.equal(rendered, readFileSync(file, "utf8"));
  });
}

// The fixtures above are user content: what the user typed stays in their own words on every
// screen. Only the copy around it must be localized.
const USER_CONTENT = [
  "Позвонить клиенту",
  "Позвонить маме",
  "Запустить первую платную группу",
  "Объяснить ошибку и предложить два решения.",
  "Подготовить список вариантов",
  "Подготовить список",
  "Собрать факты",
  "Написать письмо",
  "Полить цветы",
  "Проверить спрос",
  "Разобраться с налогами",
  "Привести в порядок машину",
  "Подготовиться к собеседованию",
];

test("no screen in English or Ukrainian leaks Russian copy", () => {
  const withoutUserContent = (text) => USER_CONTENT.reduce((value, phrase) => value.split(phrase).join(""), text);
  assert.doesNotMatch(withoutUserContent(render("en")), /[а-яё]/iu, "English screens contain Cyrillic that is not user content");
  assert.doesNotMatch(withoutUserContent(render("uk")), /Настройки|Напоминание|Сегодня|Задачи\b|Цели\b|Готово\b/u, "Ukrainian screens contain Russian copy");
});
