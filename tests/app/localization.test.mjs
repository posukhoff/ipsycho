import test from "node:test";
import assert from "node:assert/strict";
import { describeAction } from "../../dist/actions/action-describe.js";
import { renderAppliedReport } from "../../dist/core/applied-report.js";
import { recurrenceLabel } from "../../dist/core/recurrence-label.js";
import { t } from "../../dist/telegram/copy/index.js";
import { ru } from "../../dist/telegram/copy/ru.js";
import { fuzzyTaskCardText, reminderCardText, settingsKeyboard, taskCardText, taskKeyboard, taskMoreKeyboard } from "../../dist/telegram/telegram-ui.js";

const now = new Date("2026-08-23T07:40:00Z");
const task = {
  id: "t",
  title: "Call the vet",
  importance: "required",
  timezone: "Europe/Kyiv",
  why: "Annual shot",
  nextAction: "Find the passport",
  checklist: [
    { text: "Passport", done: true },
    { text: "Card", done: false },
  ],
  goalTitle: "Dog health",
  nextReminderAt: new Date("2026-08-23T14:30:00Z"),
  recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,WE",
};
const occurrence = {
  id: "o",
  status: "open",
  timezone: "Europe/Kyiv",
  plannedStartAt: new Date("2026-08-23T15:00:00Z"),
  plannedEndAt: null,
  plannedLocalDate: null,
  dueAt: null,
  dueLocalDate: null,
  overdue: true,
};
const cyrillic = /[А-Яа-яЁёІіЇїЄє]/u;
const latinWord = /\b[A-Za-z]{3,}\b/u;

test("every handler string exists in all three dictionaries and English screens carry no Cyrillic", () => {
  for (const key of Object.keys(ru)) {
    assert.ok(t("uk", key).length > 0, `uk: ${key}`);
    assert.ok(t("en", key).length > 0, `en: ${key}`);
    assert.doesNotMatch(t("en", key), cyrillic, `en copy leaks Cyrillic: ${key}`);
  }
  assert.equal(t("en", "invite_created", { link: "L", days: 7 }).includes("{"), false);
});

test("task, fuzzy and reminder cards are rendered in the user's language", () => {
  const en = taskCardText(task, occurrence, now, "en");
  assert.doesNotMatch(en, cyrillic, en);
  assert.match(en, /Overdue/);
  assert.match(en, /every week: Mon, Wed/);
  assert.match(en, /Checklist 1\/2/);
  const uk = taskCardText(task, occurrence, now, "uk");
  assert.match(uk, /Прострочено/);
  assert.match(uk, /щотижня: пн, ср/);
  const fuzzy = fuzzyTaskCardText({ ...task, recurrenceRule: null, fuzzyHorizonText: "this week", reviewAt: now }, now, "en");
  assert.match(fuzzy, /Come back:/);
  const reminder = reminderCardText({ task, occurrence, purpose: "follow_up", now, locale: "en", header: "🔴 Past the deadline — reminder #3" });
  assert.match(reminder, /^🔴 Past the deadline — reminder #3\n/);
  assert.match(reminder, /in 7 h/);
  assert.doesNotMatch(reminder, cyrillic, reminder);
});

test("keyboards, labels and the applied report follow the locale", () => {
  const labels = (keyboard) => keyboard.inline_keyboard.flat().map((button) => button.text);
  assert.deepEqual(labels(taskKeyboard("11111111-1111-1111-1111-111111111111", "en", { snooze: true, mute: true })).slice(0, 1), ["✅ Done"]);
  assert.ok(labels(taskKeyboard("11111111-1111-1111-1111-111111111111", "en", { snooze: true, mute: true })).includes("🔕 Enough for this task"));
  assert.ok(labels(taskMoreKeyboard("11111111-1111-1111-1111-111111111111", true, "22222222-2222-2222-2222-222222222222", "uk")).includes("❌ Скасувати завдання"));
  assert.ok(labels(settingsKeyboard("en", { morningDigestEnabled: true, weeklyReviewEnabled: true, quietHoursEnabled: false })).includes("☀️ Morning: on"));
  assert.equal(recurrenceLabel("FREQ=MONTHLY;BYMONTHDAY=1,15", "2026-12-31", "en"), "every month, 1st, 15th until 31.12.2026");
  const report = renderAppliedReport(
    [
      {
        kind: "task_updated",
        title: "Report",
        changes: [
          { field: "importance", before: "normal", after: "critical" },
          { field: "checklist", before: null, after: "checklist:2:1" },
        ],
      },
      { kind: "settings", operation: "quiet_hours" },
    ],
    now,
    "en",
  );
  assert.equal(report, "✏️ Task “Report”\n• Importance: «normal» → «critical»\n• Checklist: «2 items, done 1»\n\n⚙️ Settings updated: quiet hours");
  assert.match(
    renderAppliedReport([{ kind: "task_updated", title: "Отчёт", changes: [{ field: "importance", before: "normal", after: "critical" }] }], now, "ru"),
    /«обычная» → «критическая»/,
  );
});

test("a confirmation card names the task or goal it is about, in the user's language", () => {
  const base = { intent: "explicit", timezone: "Europe/Kyiv", reviewTime: "09:00" };
  const target = {
    kind: "occurrence",
    taskId: "11111111-1111-4111-8111-111111111111",
    taskVersion: 1,
    occurrenceId: "22222222-2222-4222-8222-222222222222",
    occurrenceVersion: 1,
    timezone: "Europe/Kyiv",
  };
  const names = { tasks: new Map([[target.taskId, "Созвон с дизайнером"]]), goals: new Map([["33333333-3333-4333-8333-333333333333", "Запуск"]]) };
  assert.equal(describeAction({ ...base, type: "set_task_state", target, state: "cancelled", note: null }, "ru", names), "Отменить «Созвон с дизайнером»");
  assert.equal(describeAction({ ...base, type: "set_task_state", target, state: "cancelled", note: null }, "en", names), "Cancel “Созвон с дизайнером”");
  assert.equal(
    describeAction(
      {
        ...base,
        type: "goal",
        op: "link",
        goalId: "33333333-3333-4333-8333-333333333333",
        goalVersion: 1,
        taskId: target.taskId,
        taskVersion: 1,
        title: null,
        why: null,
        targetDate: null,
        status: null,
        reviewEnabled: null,
      },
      "ru",
      names,
    ),
    "Связать «Созвон с дизайнером» с целью «Запуск»",
  );
  assert.equal(
    describeAction(
      {
        ...base,
        type: "settings",
        operation: "quiet_hours",
        timezone: "Europe/Kyiv",
        applyTimezoneTo: null,
        language: null,
        digestKind: null,
        enabled: true,
        time: null,
        weekday: null,
        weekdayStart: "23:00",
        weekdayEnd: "08:00",
        weekendStart: "23:00",
        weekendEnd: "10:00",
        snoozeUntilDate: null,
        snoozeUntilTime: null,
        eventOffsets: null,
        plannedTaskOffsetMinutes: null,
        criticalPostDueMinutes: null,
        seenNormalMinutes: null,
        seenRequiredMinutes: null,
        seenCriticalMinutes: null,
        expectedVersion: 1,
      },
      "ru",
    ),
    "Изменить настройки: тихие часы → on, 23:00–08:00, 23:00–10:00",
  );
  assert.doesNotMatch(describeAction({ ...base, type: "set_task_state", target, state: "done", note: null }, "en"), latinWord.source.includes("x") ? /$^/ : cyrillic);
});
