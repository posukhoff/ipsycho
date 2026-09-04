import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { deterministicCopy, guideText, helpText } from "../../dist/telegram/telegram-handlers.service.js";
import { goalsOverviewText, reminderCardText, settingsText, taskCardText, tasksOverviewText, terminalTaskText, todayText } from "../../dist/telegram/telegram-ui.js";
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

function render(locale) {
  const copy = deterministicCopy(locale);
  const sections = [
    ["start", copy.ready],
    ["onboarding: timezone", copy.startOnboarding],
    ["help", helpText(config, locale)],
    ["guide", guideText(locale)],
    ["settings", settingsText(settings, NOW, 42, locale)],
    ["today", todayText([{ task: { ...task, id: "t1" }, occurrence }], "2026-09-04", locale, 2, 6, NOW)],
    ["tasks", tasksOverviewText([{ task: { ...task, id: "t1" }, occurrence }], locale, NOW)],
    [
      "goals",
      goalsOverviewText(
        [
          {
            goal: { title: "Запустить первую платную группу", status: "active", why: "Проверить спрос", targetLocalDate: "2026-12-01" },
            tasks: [{ title: "Позвонить клиенту", nextAction: "Подготовить список", context: null, dueLocalDate: "2026-09-05" }],
          },
        ],
        locale,
      ),
    ],
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
  "Запустить первую платную группу",
  "Объяснить ошибку и предложить два решения.",
  "Подготовить список вариантов",
  "Подготовить список",
  "Собрать факты",
  "Написать письмо",
  "Полить цветы",
  "Проверить спрос",
];

test("no screen in English or Ukrainian leaks Russian copy", () => {
  const withoutUserContent = (text) => USER_CONTENT.reduce((value, phrase) => value.split(phrase).join(""), text);
  assert.doesNotMatch(withoutUserContent(render("en")), /[а-яё]/iu, "English screens contain Cyrillic that is not user content");
  assert.doesNotMatch(withoutUserContent(render("uk")), /Настройки|Напоминание|Сегодня|Задачи\b|Цели\b|Готово\b/u, "Ukrainian screens contain Russian copy");
});
