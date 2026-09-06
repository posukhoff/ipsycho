import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { deterministicCopy, helpText } from "../../dist/telegram/telegram-handlers.service.js";
import { reminderCardText, taskCardText, terminalTaskText, todayLine } from "../../dist/telegram/telegram-ui.js";
import { t } from "../../dist/telegram/copy/index.js";
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

/**
 * Everything the bot still writes, in one file per locale.
 *
 * Task 11 took the screens out of this list; what is left is the conversation's own copy, the
 * cards, and the one sentence a command or button that moved into the app answers with. A snapshot
 * that still pinned a deleted screen is the failure this step exists to catch.
 */
function render(locale) {
  const copy = deterministicCopy(locale);
  const sections = [
    ["start", copy.ready],
    // Sent only when the app is on, so it is a separate section for the same reason it is a
    // separate string: with the flag off it would point at a menu button Telegram never got.
    ["start: the app sentence", copy.readyApp],
    ["onboarding: timezone", copy.startOnboarding],
    ["onboarding: done", copy.onboardingDone],
    ["help", helpText(config, locale)],
    ["moved to the app", t(locale, "moved_to_app")],
    ["moved to the app: toast", t(locale, "moved_to_app_toast")],
    ["task card", taskCardText(task, occurrence, NOW, locale)],
    ["reminder card", reminderCardText({ task, occurrence, purpose: "user_reminder", now: NOW, locale })],
    ["terminal card", terminalTaskText(task, "done", NOW, locale)],
    ["morning card line", todayLine(task, occurrence, LOCAL_DATE, locale, NOW)],
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
  "Собрать факты",
  "Написать письмо",
  "Полить цветы",
];

test("nothing the bot writes in English or Ukrainian leaks Russian copy", () => {
  const withoutUserContent = (text) => USER_CONTENT.reduce((value, phrase) => value.split(phrase).join(""), text);
  assert.doesNotMatch(withoutUserContent(render("en")), /[а-яё]/iu, "English copy contains Cyrillic that is not user content");
  assert.doesNotMatch(withoutUserContent(render("uk")), /Настройки|Напоминание|Сегодня|Задачи\b|Цели\b|приложении/u, "Ukrainian copy contains Russian");
});
