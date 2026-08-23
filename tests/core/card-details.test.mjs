import test from "node:test";
import assert from "node:assert/strict";
import { isRedundantText, looksLikePlanningChore, selectCardDetails } from "../../.core-dist/card-details.js";

test("fields that only restate the title are dropped", () => {
  // The production case: three fields, one sentence.
  assert.deepEqual(selectCardDetails({
    title: "Контрольное напоминание о вакцинации",
    why: "Чтобы напомнить о вакцинации через год.",
    nextAction: "Напомнить о вакцинации",
    context: "Контрольное напоминание ровно через год в 10:00.",
  }), { why: null, nextAction: null, context: null });
  assert.deepEqual(selectCardDetails({ title: "Позвонить маме", why: null, nextAction: "Позвонить маме вечером", context: "позвонить маме" }),
    { why: null, nextAction: null, context: null });
});

test("fields that add something survive; a step the checklist already lists does not", () => {
  assert.deepEqual(selectCardDetails({
    title: "Прийти на вакцинацию собаки",
    why: "Плановая прививка Морти.",
    nextAction: "Взять паспорт собаки и карту прививок",
    context: "Клиника на Лесной, врач Иванова.",
    checklist: [{ text: "Паспорт собаки", done: true }, { text: "Карта прививок", done: false }],
    goalTitle: "Здоровье Морти",
  }), { why: "Плановая прививка Морти.", nextAction: null, context: "Клиника на Лесной, врач Иванова." });
  // Without the checklist the same step is new information.
  assert.equal(selectCardDetails({ title: "Прийти на вакцинацию собаки", nextAction: "Взять паспорт собаки и карту прививок" }).nextAction, "Взять паспорт собаки и карту прививок");
  assert.deepEqual(selectCardDetails({ title: "Подготовить квартальный отчёт", nextAction: "Выгрузить продажи за июль из CRM", context: "Шаблон прошлого квартала у Лены" }),
    { why: null, nextAction: "Выгрузить продажи за июль из CRM", context: "Шаблон прошлого квартала у Лены" });
});

test("why that merely names the goal, and a next step that the checklist already lists, are dropped", () => {
  assert.deepEqual(selectCardDetails({ title: "Пробежка 5 км", why: "Подготовка к полумарафону", goalTitle: "Подготовиться к полумарафону" }),
    { why: null, nextAction: null, context: null });
  assert.deepEqual(selectCardDetails({
    title: "Собрать документы на визу", nextAction: "Заполнить анкету",
    checklist: [{ text: "Фото", done: true }, { text: "Заполнить анкету", done: false }, { text: "Справка с работы", done: false }],
  }), { why: null, nextAction: null, context: null });
});

test("planning chores the bot already does are not next steps", () => {
  for (const text of ["Поставить напоминание на 17:00", "Запланировать задачу на завтра", "Решить, когда заняться", "Открыть список задач", "Set a reminder for tomorrow", "Добавить в календарь встречу"]) {
    assert.equal(looksLikePlanningChore(text), true, text);
  }
  for (const text of ["Напомнить Саше про документы", "Позвонить в клинику и записаться", "Купить билеты на поезд"]) {
    assert.equal(looksLikePlanningChore(text), false, text);
  }
  assert.deepEqual(selectCardDetails({ title: "Отпуск в сентябре", nextAction: "Поставить напоминание купить билеты" }).nextAction, null);
});

test("redundancy is judged on meaningful words, not short mentions", () => {
  assert.equal(isRedundantText("Позвонить маме", ["Позвонить маме завтра в 18:00"]), true);
  assert.equal(isRedundantText("Разобрать гараж и вынести мусор", ["Гараж"]), false);
  assert.equal(isRedundantText("Сон", ["Лечь спать до 23:00, чтобы выспаться"]), false);
  assert.equal(isRedundantText("Для здоровья", ["Здоровье"]), true);
  assert.equal(isRedundantText("", ["Что угодно"]), true);
});
