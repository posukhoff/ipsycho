import test from "node:test";
import assert from "node:assert/strict";
import { createChatHarness } from "./helpers/chat-harness.mjs";
import { AiTurnSchema } from "../../dist/core/ai-contract.js";

/**
 * The nine real dialogs of docs/AGENT_FLOW.md §2.7 (the phrasings scripts/qa-agent-flow.mjs
 * replays) plus the ownership of a bare "да". Every one of them failed on the old contract
 * for a reason that lived in the pipeline, not in the model: a second call to repair a
 * domain error, a shape rule that forbade two action types in one message, a raw English
 * rule text shown to the user. These tests pin the pipeline half of that.
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const timezone = "Europe/Kyiv";

let messageId = 5000;
function send(harness, text, extra = {}) {
  messageId += 1;
  return harness.chat.processText({
    workspaceId, userId, aiStatus: "enabled", timezone, language: "ru", text,
    telegramChatId: 4242, telegramMessageId: messageId, ...extra,
  });
}

function taskBody(over = {}) {
  return {
    title: "Задача", why: null, nextAction: null, context: null, checklist: null,
    importance: "normal", kind: "task",
    when: { mode: "date", date: "2026-09-05" },
    recurrence: null, reminder: null, habit: null, timezone: null,
    ...over,
  };
}

function createTask(over = {}) {
  const { goal = null, intent = "explicit", ...body } = over;
  return { type: "create_task", intent, ...taskBody(body), goal };
}

function reschedule(over = {}) {
  return {
    type: "reschedule", intent: "explicit", task: { id: "t1" },
    when: { mode: "exact", date: "2026-09-07", time: "16:00", durationMinutes: null },
    reason: null, scope: null, recurrence: null, timezone: null, ...over,
  };
}

function goalAction(over = {}) {
  return {
    type: "goal", intent: "explicit", op: "link", goal: { id: "g1" }, task: { id: "t1" },
    title: null, why: null, targetDate: null, status: null, reviewEnabled: null, ...over,
  };
}

const turn = (reply, actions, over = {}) => ({
  reply, question: null, actions, topic: { mode: "none", title: null, summary: null }, ...over,
});

/** The user never sees an internal rule: those are English and belong in the log. */
function assertNoRuleText(text) {
  assert.doesNotMatch(text, /[A-Za-z]{4,}/u, `reply leaks a rule text: ${text}`);
  assert.doesNotMatch(text, /не смог безопасно определить/iu);
}

const weekdayHabit = {
  frequency: "weekly", interval: 1, weekdays: ["MO", "TU", "WE", "TH", "FR"],
  monthDays: null, until: "2026-09-30", skipDates: null, missed: null,
};

const DIALOGS = [
  {
    label: "create with a reminder is one call and one applied package",
    text: "Создай задачу: завтра в 10:30 позвонить клиенту, цель — честно объяснить ошибку и предложить два варианта решения. Напомни в момент начала.",
    turn: turn("Записал звонок клиенту на завтра в 10:30, напомню в момент начала.", [
      createTask({
        title: "Позвонить клиенту",
        why: "Честно объяснить ошибку и предложить два варианта решения",
        when: { mode: "exact", date: "2026-09-05", time: "10:30", durationMinutes: null },
        reminder: { kind: "offset", anchor: "start", minutes: 0, quiet: "respect" },
      }),
    ]),
    check: (result, harness) => {
      assert.equal(result.appliedCount, 1);
      assert.equal(harness.handled[0].resolved[0].reminder.kind, "offset");
    },
  },
  {
    label: "«напомни через четыре часа» becomes one task with an exact time, not a legacy conflict",
    text: "Напомни через четыре часа посмотреть курс по ИИ",
    turn: turn("Напомню сегодня в 18:05 посмотреть курс.", [
      createTask({
        title: "Посмотреть курс по ИИ",
        when: { mode: "exact", date: "2026-09-04", time: "18:05", durationMinutes: null },
        reminder: { kind: "offset", anchor: "start", minutes: 0, quiet: "respect" },
      }),
    ]),
    check: (result, harness) => {
      assert.equal(result.appliedCount, 1);
      assert.deepEqual(harness.handled[0].resolved[0].when, { mode: "exact", date: "2026-09-04", time: "18:05", durationMinutes: null });
    },
  },
  {
    label: "an event with a duration goes through as exact + durationMinutes",
    text: "Закинь мне на понедельник в полдесятого утра созвон с дизайнером минут на сорок.",
    turn: turn("Поставил созвон с дизайнером на понедельник в 09:30, сорок минут.", [
      createTask({
        title: "Созвон с дизайнером", kind: "event",
        when: { mode: "exact", date: "2026-09-07", time: "09:30", durationMinutes: 40 },
      }),
    ]),
    check: (result, harness) => {
      assert.equal(result.appliedCount, 1);
      assert.equal(harness.handled[0].resolved[0].when.durationMinutes, 40);
    },
  },
  {
    label: "two reschedules in one message are one package, not a rejected mixed batch",
    text: "Перенеси созвон с дизайнером на понедельник в 16:00, а звонок клиенту на четверг с 15:00 до 16:00.",
    turn: turn("Перенёс оба.", [
      reschedule({ task: { id: "t1" } }),
      reschedule({ task: { id: "t2" }, when: { mode: "exact", date: "2026-09-10", time: "15:00", durationMinutes: 60 } }),
    ]),
    check: (result, harness) => {
      assert.equal(harness.handled.length, 1);
      assert.equal(harness.handled[0].resolved.length, 2);
      assert.deepEqual(harness.handled[0].resolved.map((action) => action.task.id), ["t1", "t2"]);
      assert.equal(result.appliedCount, 2);
    },
  },
  {
    label: "a create carrying a goal link is one action, not a second question",
    text: "Создай задачу «Попросить обратную связь по лендингу» на пятницу в 12:00 и свяжи её с целью запуска группы.",
    turn: turn("Создал задачу на пятницу в 12:00 и привязал к цели запуска группы.", [
      createTask({
        title: "Попросить обратную связь по лендингу",
        when: { mode: "exact", date: "2026-09-11", time: "12:00", durationMinutes: null },
        goal: { id: "g1" },
      }),
    ]),
    check: (result, harness) => {
      assert.equal(result.appliedCount, 1);
      assert.deepEqual(harness.handled[0].resolved[0].goal, { id: "g1" });
    },
  },
  {
    label: "a reschedule, a create and a goal link travel in one package of three",
    text: "Перенеси лендинг, создай задачу про обратную связь по нему и свяжи её с целью запуска группы.",
    turn: turn("Перенёс лендинг, создал задачу про обратную связь и связал её с целью.", [
      reschedule({ task: { id: "t1" } }),
      createTask({ title: "Собрать обратную связь по лендингу" }),
      goalAction({ task: { id: "t2" } }),
    ]),
    check: (result, harness) => {
      assert.equal(harness.handled.length, 1);
      assert.deepEqual(harness.handled[0].resolved.map((action) => action.type), ["reschedule", "create_task", "goal"]);
      assert.equal(result.appliedCount, 3);
    },
  },
  {
    label: "«каждый второй понедельник до конца ноября» reaches the actions layer unchanged",
    text: "Поставь с сентября каждый второй понедельник в 9:15 финансовый обзор на 30 минут, до конца ноября.",
    turn: turn("Завёл финансовый обзор каждый второй понедельник в 9:15 до конца ноября.", [
      createTask({
        title: "Финансовый обзор", kind: "event",
        when: { mode: "exact", date: "2026-09-07", time: "09:15", durationMinutes: 30 },
        recurrence: { frequency: "weekly", interval: 2, weekdays: ["MO"], monthDays: null, until: "2026-11-30", skipDates: null, missed: null },
      }),
    ]),
    check: (result, harness) => {
      assert.equal(result.appliedCount, 1);
      assert.deepEqual(harness.handled[0].resolved[0].recurrence, {
        frequency: "weekly", interval: 2, weekdays: ["MO"], monthDays: null, until: "2026-11-30", skipDates: null, missed: null,
      });
    },
  },
  {
    label: "a weekly recurrence with a skipped first date is not rejected by the chat layer",
    text: "Каждый вторник в 19:00 до октября хочу заниматься английским час, но ближайший вторник пропусти.",
    turn: turn("Английский каждый вторник в 19:00 до конца октября, ближайший пропускаю.", [
      createTask({
        title: "Английский",
        when: { mode: "exact", date: "2026-09-15", time: "19:00", durationMinutes: 60 },
        recurrence: { frequency: "weekly", interval: 1, weekdays: ["TU"], monthDays: null, until: "2026-10-31", skipDates: ["2026-09-08"], missed: null },
      }),
    ]),
    check: (result, harness) => {
      assert.equal(result.appliedCount, 1);
      assert.deepEqual(harness.handled[0].resolved[0].recurrence.skipDates, ["2026-09-08"]);
    },
  },
  {
    label: "four tasks where the last one is a habit pass through as four actions without a re-ask",
    text: "Добавь сразу четыре дела: 1) в понедельник в 14:00 забрать документы; 2) во вторник до 17:00 отправить бухгалтеру выписку; 3) в четверг с 10:00 до 11:00 подготовиться к сложному разговору; 4) по будням в 8:00 до 30 сентября 10 минут планировать день — это именно повторяющаяся привычка, минимум открыть план и выбрать одно главное дело, желаемый вариант — расписать три приоритета.",
    turn: turn("Завёл все четыре, последнее — как привычку по будням в 8:00.", [
      createTask({ title: "Забрать документы", when: { mode: "exact", date: "2026-09-07", time: "14:00", durationMinutes: null } }),
      createTask({ title: "Отправить бухгалтеру выписку", when: { mode: "deadline", date: "2026-09-08", time: "17:00" } }),
      createTask({ title: "Подготовиться к сложному разговору", when: { mode: "exact", date: "2026-09-10", time: "10:00", durationMinutes: 60 } }),
      createTask({
        title: "Планировать день",
        when: { mode: "exact", date: "2026-09-07", time: "08:00", durationMinutes: 10 },
        recurrence: weekdayHabit,
        habit: { minimumAction: "Открыть план и выбрать одно главное дело", desiredAction: "Расписать три приоритета", trigger: null },
      }),
    ]),
    check: (result, harness) => {
      assert.equal(harness.handled.length, 1);
      assert.equal(harness.handled[0].resolved.length, 4);
      assert.equal(harness.handled[0].resolved[3].habit.minimumAction, "Открыть план и выбрать одно главное дело");
      assert.equal(result.appliedCount, 4);
    },
  },
  {
    label: "«точного часа не знаю» becomes a day without a time instead of an invented checkpoint",
    text: "Не дай забыть: завтра после обеда надо забрать посылку. Точного часа не знаю, не придумывай его сам.",
    turn: turn("Поставил на завтра без точного часа — напомню утром.", [
      createTask({ title: "Забрать посылку", when: { mode: "date", date: "2026-09-05" } }),
    ]),
    check: (result, harness) => {
      assert.equal(result.appliedCount, 1);
      assert.deepEqual(harness.handled[0].resolved[0].when, { mode: "date", date: "2026-09-05" });
    },
  },
];

for (const dialog of DIALOGS) {
  test(dialog.label, async () => {
    // The scripted turn must itself be a legal turn of the current contract.
    AiTurnSchema.parse(dialog.turn);
    const harness = createChatHarness({ turns: [dialog.turn] });
    const result = await send(harness, dialog.text);

    assert.equal(result.kind, "ok");
    assert.equal(harness.calls.length, 1, "one user message is exactly one model call");
    assert.equal(harness.calls[0].correction, undefined, "an ordinary turn carries no correction");
    assert.equal(harness.handled.length, 1);
    assert.deepEqual(
      harness.handled[0].resolved.map((action) => action.type),
      dialog.turn.actions.map((action) => action.type),
      "handleProposed receives exactly the actions the model returned",
    );
    assert.deepEqual(harness.prepared[0].actions, dialog.turn.actions);
    assertNoRuleText(result.text);
    assert.equal(harness.retries.length, 0);
    dialog.check(result, harness);
  });
}

test("a domain issue is answered deterministically, without a second model call or a retry", async () => {
  const scripted = turn("Поставил на вчера в 10:00.", [
    createTask({ title: "Позвонить клиенту", when: { mode: "exact", date: "2026-09-03", time: "10:00", durationMinutes: null } }),
  ]);
  const harness = createChatHarness({
    turns: [scripted],
    issues: [[{ kind: "domain", index: 0, code: "time_past", message: "plannedStartAt must not be in the past when creating a one-time task" }]],
  });
  const result = await send(harness, "Напомни через четыре часа посмотреть курс по ИИ");

  assert.equal(result.kind, "ok");
  assert.match(result.text, /уже в прошлом/iu);
  assertNoRuleText(result.text);
  assert.equal(harness.calls.length, 1, "a domain error never earns a second model call");
  assert.equal(harness.handled.length, 0, "nothing is applied when an action was rejected");
  assert.equal(harness.retries.length, 0, "a rejected action is not a transport failure");
  assert.equal(harness.statuses.at(-1)?.status, "processed");
  assert.equal(result.appliedCount, 0);
  assert.equal(result.pendingCount, 0);
});

test("a package that fails validation says nothing was applied before naming the reason", async () => {
  const scripted = turn("Перенёс оба.", [reschedule({ task: { id: "t1" } }), reschedule({ task: { id: "t9" } })]);
  const harness = createChatHarness({
    turns: [scripted],
    issues: [[{ kind: "reference", index: 1, code: "ref_not_found", message: "task t9 is not in the current context" }]],
  });
  const result = await send(harness, "Перенеси созвон с дизайнером на понедельник в 16:00, а звонок клиенту на четверг с 15:00 до 16:00.");

  assert.match(result.text, /^Ничего не применил/u);
  assert.match(result.text, /Не нашёл/u);
  assert.doesNotMatch(result.text, /t9/u);
  assert.equal(harness.handled.length, 0);
});

test("a bare «да» confirms the card the bot last sent, without calling the model", async () => {
  const harness = createChatHarness({
    turns: [],
    lastAssistant: { id: "assistant-1", pendingGroupId: "group-live" },
    pendingSummary: { groupId: "group-live", createdAt: new Date(), titles: ["Отменить созвон с дизайнером"] },
    confirmResult: { groupId: "group-live", count: 1, titles: ["Отменить созвон с дизайнером"], items: [] },
  });
  const result = await send(harness, "да");

  assert.equal(result.kind, "ok");
  assert.equal(harness.calls.length, 0, "an answer to a card never reaches the provider");
  assert.deepEqual(harness.confirmed, ["group-live"]);
  assert.equal(result.appliedCount, 1);
  assert.equal(result.appliedGroupId, "group-live");
  assert.deepEqual(harness.statuses.at(-1)?.status, "processed");
});

test("a bare «нет» drops the live card and changes nothing", async () => {
  const harness = createChatHarness({
    turns: [],
    lastAssistant: { id: "assistant-1", pendingGroupId: "group-live" },
    pendingSummary: { groupId: "group-live", createdAt: new Date(), titles: ["Отменить созвон"] },
  });
  const result = await send(harness, "нет");

  assert.equal(harness.calls.length, 0);
  assert.deepEqual(harness.cancelled, ["group-live"]);
  assert.equal(result.appliedCount, 0);
  assert.match(result.text, /ничего не изменил/iu);
});

test("a bare «да» with no live card goes to the model instead of confirming something else", async () => {
  const scripted = turn("Хорошо, что именно подтверждаем?", []);
  const harness = createChatHarness({ turns: [scripted], lastAssistant: null, pendingSummary: null });
  const result = await send(harness, "да");

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.confirmed.length, 0);
  assert.equal(result.kind, "ok");
});

test("an explicit action while a card is live replaces the card: cancel first, then apply", async () => {
  const scripted = turn("Отменил созвон.", [
    { type: "set_task_state", intent: "explicit", task: { id: "t1" }, state: "cancelled", note: null, scope: "occurrence" },
  ]);
  const harness = createChatHarness({
    turns: [scripted],
    lastAssistant: { id: "assistant-1", pendingGroupId: "group-old" },
    pendingSummary: { groupId: "group-old", createdAt: new Date(), titles: ["Отменить созвон с дизайнером"] },
  });
  const result = await send(harness, "да, отмени созвон с дизайнером");

  assert.deepEqual(harness.cancelled, ["group-old"]);
  assert.equal(harness.handled.length, 1);
  assert.equal(harness.handled[0].cancelledBefore, 1, "the old card is cancelled before the new package is applied");
  assert.equal(result.supersededPendingGroupId, "group-old");
  assert.equal(result.appliedCount, 1);
});

test("a new pending card supersedes the old one so only one card is ever live", async () => {
  const scripted = turn("Предлагаю отменить серию.", [
    { type: "set_task_state", intent: "inferred", task: { id: "t1" }, state: "cancelled", note: null, scope: "series" },
  ]);
  const harness = createChatHarness({
    turns: [scripted],
    pending: { groupId: "group-new", count: 1, titles: ["Отменить серию"] },
    lastAssistant: { id: "assistant-1", pendingGroupId: "group-old" },
    pendingSummary: { groupId: "group-old", createdAt: new Date(), titles: ["Старое предложение"] },
  });
  const result = await send(harness, "а может вообще убрать эти регулярные созвоны");

  assert.equal(harness.handled.length, 1);
  assert.equal(harness.handled[0].cancelledBefore, 0, "an inferred proposal does not pre-cancel; the new card supersedes after it exists");
  assert.deepEqual(harness.cancelled, ["group-old"]);
  assert.equal(result.pendingGroupId, "group-new");
  assert.equal(result.supersededPendingGroupId, "group-old");
  assert.equal(result.pendingCount, 1);
});

test("an unusable structured output asks for a rephrase and is not retried", async () => {
  const harness = createChatHarness({ turns: ["unparseable"] });
  const result = await send(harness, "Напомни через четыре часа посмотреть курс по ИИ");

  assert.equal(result.kind, "ok");
  assert.match(result.text, /Не понял/u);
  assertNoRuleText(result.text);
  assert.deepEqual(harness.statuses.at(-1)?.status, "processed");
  assert.equal(harness.retries.length, 0);
  assert.equal(harness.handled.length, 0);
  assert.equal(result.appliedCount, 0);
});

test("«ничего не сохраняй» drops the actions before they ever reach the actions layer", async () => {
  const scripted = turn("Понял, ничего не сохраняю.", [createTask({ title: "Забрать посылку" })]);
  const harness = createChatHarness({ turns: [scripted] });
  const result = await send(harness, "Ничего не сохраняй, просто подумаем вслух: что мне делать с лендингом?");

  assert.equal(harness.calls.length, 1);
  assert.match(harness.calls[0].correction ?? "", /actions=\[\]/u);
  assert.equal(harness.prepared.length, 0, "no action survives a no-persist turn");
  assert.equal(harness.handled.length, 0);
  assert.equal(result.appliedCount, 0);
  assert.equal(result.pendingCount, 0);
});
