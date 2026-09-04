import test from "node:test";
import assert from "node:assert/strict";
import { fuzzyTaskCardText, reminderCardText, settingsText, taskCardText, tasksOverviewText, todayText } from "../../dist/telegram/telegram-ui.js";
import { describeAction } from "../../dist/actions/actions.service.js";

const now = new Date("2026-08-23T07:40:00Z"); // 10:40 Kyiv
const task = {
  id: "t", title: "Прийти на вакцинацию собаки", importance: "required", timezone: "Europe/Kyiv",
  why: "Плановая прививка Морти.", nextAction: "Взять паспорт собаки и карту прививок", context: "Клиника на Лесной, врач Иванова.",
  checklist: [{ text: "Паспорт собаки", done: true }, { text: "Карта прививок", done: false }],
  goalTitle: "Здоровье Морти", nextReminderAt: new Date("2026-08-23T14:30:00Z"),
};
const occurrence = { id: "o", status: "open", timezone: "Europe/Kyiv", plannedStartAt: new Date("2026-08-23T15:00:00Z"), plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null };

test("task card shows time, real next reminder, rationale, context, checklist and goal; the checklist replaces the next step", () => {
  assert.equal(taskCardText(task, occurrence, now), [
    "🟡 Прийти на вакцинацию собаки",
    "📅 23.08, 18:00 (Europe/Kyiv) · 🔔 17:30",
    "",
    "💡 Зачем: Плановая прививка Морти.",
    "📝 Клиника на Лесной, врач Иванова.",
    "☑️ Чеклист 1/2",
    "✅ Паспорт собаки",
    "◻️ Карта прививок",
    "🎯 Цель: «Здоровье Морти»",
  ].join("\n"));
});

test("task card explains recurrence, windows, overdue duration and another year", () => {
  const recurring = { title: "Зарядка", importance: "normal", timezone: "Europe/Kyiv", recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR" };
  const window = { ...occurrence, plannedStartAt: new Date("2026-08-24T05:00:00Z"), plannedEndAt: new Date("2026-08-24T05:30:00Z") };
  assert.equal(taskCardText(recurring, window, now), "Зарядка\n📅 24.08, 08:00–08:30 (Europe/Kyiv)\n🔁 каждую неделю: пн, ср, пт");

  const overdue = { ...occurrence, overdue: true, plannedStartAt: new Date("2026-08-23T05:40:00Z") };
  assert.equal(taskCardText({ title: "Созвон", importance: "critical", timezone: "Europe/Kyiv" }, overdue, now), "🔴 Созвон\n📅 23.08, 08:40 (Europe/Kyiv)\n⚠️ Просрочено на 2 ч");

  const nextYear = { ...occurrence, plannedStartAt: new Date("2027-08-23T07:00:00Z") };
  assert.equal(taskCardText({ title: "Записаться на вакцинацию Морти", importance: "normal", timezone: "Europe/Kyiv" }, nextYear, now), "Записаться на вакцинацию Морти\n📅 23.08.2027, 10:00 (Europe/Kyiv)");

  const deadline = { ...occurrence, plannedStartAt: null, dueLocalDate: "2026-09-01" };
  assert.equal(taskCardText({ title: "Отчёт", importance: "normal", timezone: "Europe/Kyiv" }, deadline, now), "Отчёт\n📅 до 01.09 (Europe/Kyiv)");
});

test("fuzzy card keeps the horizon and review date and still shows details", () => {
  assert.equal(fuzzyTaskCardText({ title: "Разобрать гараж", importance: "normal", timezone: "Europe/Kyiv", fuzzyHorizonText: "на этой неделе", reviewAt: new Date("2026-08-28T06:00:00Z"), nextAction: "Вынести старые коробки" }, now),
    "Разобрать гараж\n🫧 на этой неделе\n🗓 Вернуться: 28.08, 09:00 (Europe/Kyiv)\n\n➡️ Следующий шаг: Вынести старые коробки");
});

test("reminder card leads with what to do now and says how soon", () => {
  const text = reminderCardText({ task, occurrence, purpose: "user_reminder", now: new Date("2026-08-23T14:30:00Z") });
  assert.equal(text, [
    "🔔 🟡 Прийти на вакцинацию собаки",
    "📅 23.08, 18:00 (Europe/Kyiv) · 🔔 17:30 · через 30 мин",
    "📝 Клиника на Лесной, врач Иванова.",
    "☑️ Чеклист 1/2",
    "✅ Паспорт собаки",
    "◻️ Карта прививок",
  ].join("\n"));
  const withStep = reminderCardText({ task: { title: "Подготовить квартальный отчёт", importance: "normal", timezone: "Europe/Kyiv", nextAction: "Выгрузить продажи за июль из CRM" }, occurrence, purpose: "user_reminder", now: new Date("2026-08-23T14:30:00Z") });
  assert.equal(withStep, "🔔 Подготовить квартальный отчёт\n📅 23.08, 18:00 (Europe/Kyiv) · через 30 мин\n➡️ Выгрузить продажи за июль из CRM");
  const followUp = reminderCardText({ task: { title: "Созвон", importance: "normal", timezone: "Europe/Kyiv" }, occurrence: { ...occurrence, status: "in_progress" }, purpose: "follow_up", now: new Date("2026-08-23T15:20:00Z") });
  assert.equal(followUp, "↩️ Созвон\n📅 23.08, 18:00 (Europe/Kyiv) · ⚠️ просрочено на 20 мин\n\nКак идёт?");
});

test("today and task lists always show when, including deadlines and other days", () => {
  const rows = [
    { task: { id: "1", title: "Созвон", importance: "required", timezone: "Europe/Kyiv" }, occurrence: { ...occurrence, id: "a", plannedStartAt: new Date("2026-08-23T08:00:00Z"), plannedEndAt: new Date("2026-08-23T08:30:00Z") } },
    { task: { id: "2", title: "Отчёт", importance: "normal", timezone: "Europe/Kyiv" }, occurrence: { ...occurrence, id: "b", plannedStartAt: null, dueAt: new Date("2026-08-23T15:00:00Z") } },
    { task: { id: "3", title: "Вчерашнее", importance: "normal", timezone: "Europe/Kyiv" }, occurrence: { ...occurrence, id: "c", overdue: true, plannedStartAt: new Date("2026-08-22T15:00:00Z") } },
    { task: { id: "4", title: "Гараж", importance: "normal", timezone: "Europe/Kyiv", fuzzyHorizonText: "на неделе" }, occurrence: null },
  ];
  assert.equal(todayText(rows, "2026-08-23", "ru", 1, 6, now), [
    "☀️ Сегодня · 4 дела",
    "",
    "Главное: Созвон",
    "",
    "🟡 Созвон · 11:00–11:30",
    "• Отчёт · до 18:00",
    "• Вчерашнее · 22.08, 18:00 · просрочено",
    "🫧 Гараж",
    "",
    "✅ Выполнено сегодня: 1",
  ].join("\n"));
  assert.equal(tasksOverviewText(rows, "ru", now), [
    "📋 Задачи",
    "",
    "1. 🟡 Созвон · 23.08, 11:00–11:30",
    "2. • Отчёт · до 23.08, 18:00",
    "3. • Вчерашнее · 22.08, 18:00 · просрочено",
    "4. 🫧 Гараж · 🫧 на неделе",
    "",
    "Чтобы изменить, завершить или перенести задачу, напиши это обычным сообщением.",
  ].join("\n"));
});

test("pending confirmation describes the concrete change", () => {
  const base = { intent: "explicit", timezone: "Europe/Kyiv", reviewTime: "09:00" };
  const body = {
    title: "Зарядка", why: null, nextAction: null, context: null, checklist: null, importance: "normal", kind: "task",
    when: { mode: "exact", date: "2026-08-25", time: "09:30", durationMinutes: null }, recurrence: null, reminder: null, habit: null, timezone: null,
  };
  const target = { kind: "occurrence", taskId: "11111111-1111-4111-8111-111111111111", taskVersion: 1, occurrenceId: "22222222-2222-4222-8222-222222222222", occurrenceVersion: 1, timezone: "Europe/Kyiv" };
  assert.equal(describeAction({ ...base, type: "create_task", body, goal: null }), "Создать «Зарядка» — 25.08 09:30");
  assert.equal(describeAction({ ...base, type: "update_task", taskId: target.taskId, taskVersion: 1, patch: { title: "Ежегодная вакцинация", why: null, nextAction: null, context: "раз в год", importance: null, checklist: null, habit: null } }), "Изменить задачу: название → «Ежегодная вакцинация», контекст");
  assert.equal(describeAction({ ...base, type: "set_reminder", target, mode: "replace", reminder: { kind: "offset", anchor: "start", minutes: -30, quiet: "respect" } }), "Заменить напоминание за 30 мин до начала");
  assert.equal(describeAction({ ...base, type: "reschedule", target, when: { mode: "exact", date: "2026-08-26", time: "10:00", durationMinutes: null }, recurrence: null, reason: "не успеваю" }), "Перенести — 26.08 10:00 (не успеваю)");
  assert.equal(describeAction({ ...base, type: "set_task_state", target, state: "cancelled", note: null }), "Отменить");
  assert.equal(describeAction({ ...base, type: "memory", op: "save", memoryId: null, memoryVersion: null, kind: "note", content: "Собаку зовут Морти", sensitive: true }), "Запомнить (чувствительное): «Собаку зовут Морти»");
});

test("settings show the quiet-hours window instead of hiding it", () => {
  const row = { timezone: "Europe/Kyiv", morningDigestEnabled: true, morningReferenceTime: "09:00", eveningDigestEnabled: false, eveningReferenceTime: "20:00", weeklyReviewEnabled: true, weeklyReviewWeekday: 7, weeklyReviewTime: "18:00", quietHoursEnabled: true, weekdayQuietStart: "23:00", weekdayQuietEnd: "08:00", weekendQuietStart: "23:00", weekendQuietEnd: "10:00" };
  assert.match(settingsText(row, now, 12, "ru"), /🔕 Тихие часы: 23:00–08:00 \(будни\), 23:00–10:00 \(выходные\)/);
  assert.match(settingsText({ ...row, weekendQuietStart: "23:00", weekendQuietEnd: "08:00" }, now, 12, "ru"), /🔕 Тихие часы: 23:00–08:00\n/);
  assert.match(settingsText({ ...row, quietHoursEnabled: false }, now, 12, "en"), /🔕 Quiet hours: off/);
});

test("cards drop fields that only restate the title, the goal or the checklist", () => {
  const stored = {
    title: "Контрольное напоминание о вакцинации", importance: "normal", timezone: "Europe/Kyiv",
    why: "Чтобы напомнить о вакцинации через год.", nextAction: "Напомнить о вакцинации", context: "Контрольное напоминание ровно через год в 10:00.",
  };
  const nextYear = { ...occurrence, plannedStartAt: new Date("2027-08-23T07:00:00Z") };
  assert.equal(taskCardText(stored, nextYear, now), "Контрольное напоминание о вакцинации\n📅 23.08.2027, 10:00 (Europe/Kyiv)");
  const chore = { title: "Позвонить маме", importance: "normal", timezone: "Europe/Kyiv", nextAction: "Поставить напоминание позвонить маме", context: "Мама просила позвонить до 21:00, не позже" };
  assert.equal(reminderCardText({ task: chore, occurrence, purpose: "user_reminder", now: new Date("2026-08-23T14:30:00Z") }),
    "🔔 Позвонить маме\n📅 23.08, 18:00 (Europe/Kyiv) · через 30 мин\n📝 Мама просила позвонить до 21:00, не позже");
});
