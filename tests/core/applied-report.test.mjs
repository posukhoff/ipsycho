import test from "node:test";
import assert from "node:assert/strict";
import { renderAppliedReport, taskFieldChanges } from "../../.core-dist/applied-report.js";

// Production 2026-08-23: the reply said "напомню в 17:30" and "Готово." while the store held a
// default 18:00 reminder and a rename of the wrong task. The report is rendered from stored facts only.
const now = new Date("2026-08-23T07:09:00Z");
const kyiv = (iso) => ({ timezone: "Europe/Kyiv", plannedStartAt: new Date(iso), plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null });

test("several created tasks are listed with their own time, reminder and year when it differs", () => {
  const report = renderAppliedReport(
    [
      {
        kind: "task_created",
        title: "Вакцинация",
        timezone: "Europe/Kyiv",
        importance: "normal",
        schedule: kyiv("2026-08-23T15:00:00Z"),
        reminderAt: new Date("2026-08-23T14:30:00Z"),
      },
      {
        kind: "task_created",
        title: "Записаться на вакцинацию Морти",
        timezone: "Europe/Kyiv",
        importance: "required",
        schedule: kyiv("2027-08-23T07:00:00Z"),
        reminderAt: new Date("2027-08-23T07:00:00Z"),
      },
    ],
    now,
  );
  assert.equal(
    report,
    [
      "✅ Создано задач: 2",
      "1. «Вакцинация» — 📅 23.08, 18:00 (Europe/Kyiv) · 🔔 17:30",
      "2. «Записаться на вакцинацию Морти» 🟡 — 📅 23.08.2027, 10:00 (Europe/Kyiv) · 🔔 в момент начала",
    ].join("\n"),
  );
});

test("one created task shows schedule, reminder, recurrence and goal link on separate lines", () => {
  const report = renderAppliedReport(
    [
      {
        kind: "task_created",
        title: "Зарядка",
        timezone: "Europe/Kyiv",
        importance: "normal",
        recurring: true,
        schedule: kyiv("2026-08-24T05:00:00Z"),
        reminderAt: new Date("2026-08-23T18:00:00Z"),
        goalTitle: "Здоровье",
      },
    ],
    now,
  );
  assert.equal(report, "✅ Создана задача «Зарядка» 🔁\n📅 24.08, 08:00 (Europe/Kyiv) · 🔔 23.08, 21:00\n🎯 Цель: «Здоровье»");
});

test("fuzzy and date-only tasks do not invent a clock time", () => {
  const fuzzy = renderAppliedReport(
    [
      {
        kind: "task_created",
        title: "Разобрать гараж",
        timezone: "Europe/Kyiv",
        schedule: null,
        fuzzyHorizonText: "на этой неделе",
        reviewAt: new Date("2026-08-28T06:00:00Z"),
        reminderAt: null,
      },
    ],
    now,
  );
  assert.equal(fuzzy, "✅ Создана задача «Разобрать гараж»\n🫧 на этой неделе · пересмотр 28.08, 09:00 (Europe/Kyiv)");
  const deadline = renderAppliedReport(
    [
      {
        kind: "task_created",
        title: "Сдать отчёт",
        timezone: "Europe/Kyiv",
        schedule: { timezone: "Europe/Kyiv", plannedStartAt: null, plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: "2027-01-15" },
        reminderAt: null,
      },
    ],
    now,
  );
  assert.equal(deadline, "✅ Создана задача «Сдать отчёт»\n📅 до 15.01.2027 (Europe/Kyiv) · 🔕 без напоминания");
});

test("task update lists every changed field as old → new", () => {
  const changes = taskFieldChanges(
    {
      title: "Контрольное напоминание о вакцинации",
      why: "Чтобы напомнить о вакцинации через год.",
      nextAction: null,
      context: "Контрольное напоминание ровно через год в 10:00.",
      importance: "normal",
      checklist: [],
    },
    {
      title: "Записаться на вакцинацию Морти",
      why: "Чтобы напомнить о вакцинации через год.",
      nextAction: "Позвонить в клинику",
      context: null,
      importance: "required",
      checklist: [
        { text: "a", done: true },
        { text: "b", done: false },
      ],
    },
  );
  assert.equal(
    renderAppliedReport([{ kind: "task_updated", title: "Записаться на вакцинацию Морти", changes }], now),
    [
      "✏️ Задача «Записаться на вакцинацию Морти»",
      "• Название: «Контрольное напоминание о вакцинации» → «Записаться на вакцинацию Морти»",
      "• Следующий шаг: «Позвонить в клинику»",
      "• Контекст: «Контрольное напоминание ровно через год в 10:00.» → убрано",
      "• Важность: «обычная» → «обязательная»",
      "• Чеклист: «2 пункта, выполнено 1»",
    ].join("\n"),
  );
  assert.equal(renderAppliedReport([{ kind: "task_updated", title: "X", changes: [] }], now), "✏️ Задача «X» обновлена");
});

test("reschedule shows before → after with the new reminder and reason", () => {
  const report = renderAppliedReport(
    [
      {
        kind: "task_rescheduled",
        title: "Созвон",
        before: kyiv("2026-08-23T15:00:00Z"),
        after: kyiv("2026-08-24T07:00:00Z"),
        reminderAt: new Date("2026-08-24T06:30:00Z"),
        reason: "клиент попросил",
      },
    ],
    now,
  );
  assert.equal(report, "📅 Перенесено «Созвон»: 23.08, 18:00 → 24.08, 10:00 (Europe/Kyiv)\n🔔 09:30\nПричина: клиент попросил");
});

test("a task made concrete reports its first step and its steps", () => {
  const report = renderAppliedReport(
    [
      {
        kind: "task_created",
        title: "Разобраться с налогами",
        timezone: "Europe/Kyiv",
        schedule: null,
        reminderAt: null,
        nextAction: "Скачать выписки из банка за год",
        checklist: ["Скачать выписки из банка за год", "Собрать чеки по расходам", "Заполнить декларацию"],
      },
    ],
    now,
  );
  assert.match(report, /➡️ Следующий шаг: Скачать выписки из банка за год/);
  assert.match(report, /☑️ Чеклист 0\/3/);
  assert.match(report, /◻️ Собрать чеки по расходам/);
});

test("a step that only restates the title is not reported", () => {
  const report = renderAppliedReport(
    [{ kind: "task_created", title: "Позвонить в клинику", timezone: "Europe/Kyiv", schedule: null, reminderAt: null, nextAction: "Позвонить в клинику" }],
    now,
  );
  assert.doesNotMatch(report, /Следующий шаг/);
});

test("several created tasks stay one line each, so a package does not turn into a wall of steps", () => {
  const task = (title) => ({ kind: "task_created", title, timezone: "Europe/Kyiv", schedule: null, reminderAt: null, nextAction: "Первый шаг", checklist: ["Шаг"] });
  const report = renderAppliedReport([task("Налоги"), task("Машина")], now);
  assert.doesNotMatch(report, /Следующий шаг/);
  assert.match(report, /«Налоги»/);
  assert.match(report, /«Машина»/);
});

test("reminder, occurrence, series, goal, memory and settings outcomes are all explicit", () => {
  const report = renderAppliedReport(
    [
      { kind: "reminder", title: "Вакцинация", mode: "replace", schedule: kyiv("2026-08-23T15:00:00Z"), reminderAt: new Date("2026-08-23T14:30:00Z") },
      { kind: "reminder", title: "Вакцинация", mode: "clear", schedule: kyiv("2026-08-23T15:00:00Z"), reminderAt: null },
      { kind: "occurrence", title: "Созвон", operation: "done" },
      { kind: "series", title: "Зарядка", operation: "pause" },
      { kind: "goal_created", title: "Здоровье" },
      { kind: "goal_linked", taskTitle: "Зарядка", goalTitle: "Здоровье" },
      { kind: "memory", operation: "saved", content: "Собаку зовут Морти" },
      { kind: "settings", operation: "quiet_hours" },
    ],
    now,
  );
  assert.equal(
    report,
    [
      "🔔 Напоминание «Вакцинация»: 23.08, 17:30 (Europe/Kyiv)",
      "🔕 Напоминаний для «Вакцинация» больше нет",
      "✅ Выполнено: «Созвон»",
      "🔁 Серия «Зарядка»: приостановлена",
      "🎯 Цель создана: «Здоровье»",
      "🔗 «Зарядка» → цель «Здоровье»",
      "🧠 Запомнил: «Собаку зовут Морти»",
      "⚙️ Настройки обновлены: тихие часы",
    ].join("\n\n"),
  );
});

test("goal plan lists the goal and each of its tasks", () => {
  const report = renderAppliedReport(
    [
      {
        kind: "goal_plan",
        goalTitle: "Английский",
        tasks: [
          { kind: "task_created", title: "Урок", timezone: "Europe/Kyiv", schedule: kyiv("2026-08-25T16:00:00Z"), reminderAt: new Date("2026-08-25T15:45:00Z") },
          { kind: "task_created", title: "Словарь", timezone: "Europe/Kyiv", schedule: null, fuzzyHorizonText: "в сентябре", reminderAt: null },
        ],
      },
    ],
    now,
  );
  assert.equal(report, "🎯 Цель «Английский» и задач к ней: 2\n1. «Урок» — 📅 25.08, 19:00 (Europe/Kyiv) · 🔔 18:45\n2. «Словарь» — 🫧 в сентябре (Europe/Kyiv)");
});
