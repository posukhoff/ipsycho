import type { ActionIssue } from "../core/ai-actions.js";

type Locale = "ru" | "uk" | "en";
type Copy = Record<Locale, string>;

export function rejectionLocale(language: string | null | undefined): Locale {
  const locale = language?.toLocaleLowerCase() ?? "";
  if (locale.startsWith("uk")) return "uk";
  if (locale.startsWith("en")) return "en";
  return "ru";
}

/**
 * A rejected action must name the one thing the user can change. Keyed by the issue
 * code first; the regex fallback covers domain rules that still throw plain messages.
 */
const BY_CODE: Record<string, Copy> = {
  time_past: {
    ru: "Не сохранил: получившееся время уже в прошлом. Назови новую дату и время или скажи «считай от сейчас».",
    uk: "Не зберіг: отриманий час уже в минулому. Назви нову дату й час або скажи «рахуй від зараз».",
    en: "Not saved: the resulting time is already in the past. Give a new date and time, or say to count from now.",
  },
  recurring_fuzzy: {
    ru: "Не сохранил: повторяющаяся задача не может быть с расплывчатым временем — нужен конкретный час. Назови точное время, и я заведу серию.",
    uk: "Не зберіг: повторюване завдання не може мати розпливчастий час — потрібна конкретна година. Назви точний час, і я заведу серію.",
    en: "Not saved: a recurring task needs an exact time, not a fuzzy horizon. Give an exact time and I will create the series.",
  },
  stale: {
    ru: "Не сохранил: задача или цель изменились после того, как я прочитал их. Повтори команду — перечитаю актуальную версию.",
    uk: "Не зберіг: завдання або ціль змінилися після того, як я їх прочитав. Повтори команду — перечитаю актуальну версію.",
    en: "Not saved: the task or goal changed after I read it. Repeat the command and I will re-read the current version.",
  },
  already_linked: {
    ru: "Не сохранил: такая связь уже есть, повторно заводить нечего. Скажи, если нужно наоборот убрать её.",
    uk: "Не зберіг: такий зв’язок уже існує, заводити повторно нічого. Скажи, якщо треба навпаки прибрати його.",
    en: "Not saved: that link already exists, so there is nothing to add. Tell me if you want it removed instead.",
  },
  not_linked: {
    ru: "Не изменил: эта задача и так не связана с этой целью.",
    uk: "Не змінив: це завдання й так не пов’язане з цією ціллю.",
    en: "Nothing changed: that task is not linked to that goal.",
  },
  ref_not_found: {
    ru: "Не нашёл такую задачу, цель или запись в текущем списке. Назови её точнее — например, часть названия.",
    uk: "Не знайшов таке завдання, ціль або запис у поточному списку. Назви точніше — наприклад, частину назви.",
    en: "I could not find that task, goal or note in the current list. Name it more precisely, for example part of the title.",
  },
  ref_kind_mismatch: {
    ru: "Не сохранил: перепутал, к чему относится действие. Назови задачу или цель ещё раз.",
    uk: "Не зберіг: переплутав, до чого належить дія. Назви завдання або ціль ще раз.",
    en: "Not saved: I mixed up what the action refers to. Name the task or goal again.",
  },
  fuzzy_reminder: {
    ru: "У задачи нет даты, поэтому напоминание поставить некуда. Скажи, на какой день её поставить — тогда добавлю напоминание.",
    uk: "У завдання немає дати, тому нагадування нема куди ставити. Скажи, на який день його поставити — тоді додам нагадування.",
    en: "The task has no date, so there is nothing to attach a reminder to. Give it a day and I will add the reminder.",
  },
  fuzzy_no_occurrence: {
    ru: "У этой задачи ещё нет конкретного дня, поэтому её нельзя начать, отметить увиденной или пропустить. Можно завершить, отменить или назначить дату.",
    uk: "У цього завдання ще немає конкретного дня, тому його не можна почати, позначити побаченим або пропустити. Можна завершити, скасувати або призначити дату.",
    en: "This task has no concrete day yet, so it cannot be started, marked seen or skipped. It can be completed, cancelled or given a date.",
  },
  no_current_occurrence: {
    ru: "У задачи нет активного повторения — нечего менять.",
    uk: "У завдання немає активного повторення — нічого змінювати.",
    en: "The task has no active occurrence, so there is nothing to change.",
  },
  task_not_active: {
    ru: "Задача уже закрыта или отменена — ничего не менял.",
    uk: "Завдання вже закрите або скасоване — нічого не змінював.",
    en: "The task is already closed or cancelled, so I changed nothing.",
  },
  skip_one_time: {
    ru: "Одноразовую задачу нельзя пропустить — только отменить. Сказать «отмени», если так и задумано?",
    uk: "Одноразове завдання не можна пропустити — лише скасувати. Сказати «скасуй», якщо так і задумано?",
    en: "A one-time task cannot be skipped, only cancelled. Say “cancel” if that is what you mean.",
  },
  series_state_unsupported: {
    ru: "Для всей серии можно только отменить или изменить расписание; выполнить или начать можно одно повторение.",
    uk: "Для всієї серії можна лише скасувати або змінити розклад; виконати чи почати можна одне повторення.",
    en: "A whole series can only be cancelled or rescheduled; done and started apply to one occurrence.",
  },
  not_recurring: {
    ru: "Это одноразовая задача, у неё нет серии — изменил бы только её саму. Уточни, что именно сделать.",
    uk: "Це одноразове завдання, серії в нього немає. Уточни, що саме зробити.",
    en: "That task does not repeat, so there is no series. Tell me what to change.",
  },
  duplicate_action: {
    ru: "В запросе одно и то же действие повторяется дважды — ничего не менял, уточни.",
    uk: "У запиті одна й та сама дія повторюється двічі — нічого не змінював, уточни.",
    en: "The same action appears twice in the request, so I changed nothing. Please clarify.",
  },
  quiet_hours: {
    ru: "Напоминание попадает в тихие часы. Отправить всё равно, сдвинуть после тихих часов или выбрать другое время?",
    uk: "Нагадування потрапляє в тихі години. Надіслати все одно, зсунути після тихих годин чи обрати інший час?",
    en: "The reminder falls inside quiet hours. Send it anyway, delay it until quiet hours end, or pick another time?",
  },
  reason_required: {
    ru: "Не перенёс: для этой задачи нужна причина переноса. Скажи коротко, почему.",
    uk: "Не переніс: для цього завдання потрібна причина перенесення. Скажи коротко, чому.",
    en: "Not rescheduled: this task needs a reason for the move. Say briefly why.",
  },
  date_only_offset: {
    ru: "Не сохранил: у задачи нет точного часа, поэтому «за N минут до» не от чего считать. Назови время напоминания.",
    uk: "Не зберіг: у завдання немає точної години, тому «за N хвилин до» нема від чого рахувати. Назви час нагадування.",
    en: "Not saved: the task has no clock time, so “N minutes before” has nothing to count from. Give a reminder time.",
  },
  terminal_occurrence: {
    ru: "Это повторение уже завершено или отменено — менять нечего.",
    uk: "Це повторення вже завершене або скасоване — змінювати нічого.",
    en: "That occurrence is already finished or cancelled, so there is nothing to change.",
  },
  habit_not_eligible: {
    ru: "Режим привычки здесь не подходит: он только для повторяющихся задач и предлагается один раз.",
    uk: "Режим звички тут не підходить: він лише для повторюваних завдань і пропонується один раз.",
    en: "Habit mode does not apply here: it is only for recurring tasks and is offered once.",
  },
  settings_stale: {
    ru: "Не сохранил: настройки изменились после того, как я их прочитал. Повтори команду.",
    uk: "Не зберіг: налаштування змінилися після того, як я їх прочитав. Повтори команду.",
    en: "Not saved: the settings changed after I read them. Repeat the command.",
  },
  timezone: {
    ru: "Не сохранил: такого часового пояса нет. Назови город или пояс в виде «Europe/Kyiv».",
    uk: "Не зберіг: такого часового поясу немає. Назви місто або пояс у вигляді «Europe/Kyiv».",
    en: "Not saved: that timezone does not exist. Name a city or a zone like “Europe/Kyiv”.",
  },
  ref_required: {
    ru: "Не понял, к чему это относится. Назови задачу или цель по названию.",
    uk: "Не зрозумів, до чого це стосується. Назви завдання або ціль за назвою.",
    en: "I could not tell what this refers to. Name the task or the goal.",
  },
  goal_title: {
    ru: "Не создал цель: нужно её название одной фразой.",
    uk: "Не створив ціль: потрібна її назва однією фразою.",
    en: "Goal not created: it needs a title in one phrase.",
  },
  empty_patch: {
    ru: "Ничего не менял: не понял, что именно нужно изменить.",
    uk: "Нічого не змінював: не зрозумів, що саме треба змінити.",
    en: "Nothing changed: I could not tell what to change.",
  },
  memory_shape: {
    ru: "Не запомнил: не понял, что именно сохранить. Скажи одной фразой.",
    uk: "Не запам’ятав: не зрозумів, що саме зберегти. Скажи однією фразою.",
    en: "Not saved: I could not tell what to remember. Say it in one phrase.",
  },
  blank_field: {
    ru: "Ничего не менял: одно из полей осталось пустым. Скажи, что туда записать, или что его убрать.",
    uk: "Нічого не змінював: одне з полів лишилося порожнім. Скажи, що туди записати, або що прибрати.",
    en: "Nothing changed: one of the fields came out empty. Say what to put there, or to drop it.",
  },
  reminder_shape: {
    ru: "Не понял напоминание. Скажи время или «за сколько до».",
    uk: "Не зрозумів нагадування. Скажи час або «за скільки до».",
    en: "I did not understand the reminder. Give a time, or how long before.",
  },
  recurrence_scope: {
    ru: "Расписание повтора меняется сразу для всей серии. Сказать «поменяй всю серию»?",
    uk: "Розклад повтору змінюється одразу для всієї серії. Сказати «зміни всю серію»?",
    en: "A repeat schedule changes for the whole series. Say to change the whole series?",
  },
  note_not_allowed: {
    ru: "Ничего не менял: заметку можно записать только как препятствие к задаче.",
    uk: "Нічого не змінював: нотатку можна записати лише як перешкоду до завдання.",
    en: "Nothing changed: a note can only be recorded as a blocker on the task.",
  },
  time_invalid: {
    ru: "Не сохранил: время должно быть в формате HH:MM, например 09:30.",
    uk: "Не зберіг: час має бути у форматі HH:MM, наприклад 09:30.",
    en: "Not saved: the time must be HH:MM, for example 09:30.",
  },
  timezone_scope_required: {
    ru: "Применить новый часовой пояс ко всем срокам и напоминаниям или только к профилю?",
    uk: "Застосувати новий часовий пояс до всіх строків і нагадувань чи лише до профілю?",
    en: "Apply the new timezone to every deadline and reminder, or to the profile only?",
  },
  settings_shape: {
    ru: "Не сохранил настройку: не хватает значения. Скажи, что и на что менять.",
    uk: "Не зберіг налаштування: бракує значення. Скажи, що і на що змінювати.",
    en: "Setting not saved: a value is missing. Say what to change and to what.",
  },
  plan_empty: {
    ru: "Не создал план: к цели не оказалось ни одной задачи.",
    uk: "Не створив план: до цілі не виявилося жодного завдання.",
    en: "Plan not created: the goal came with no tasks.",
  },
  task_definition: {
    ru: "Не сохранил: время и вид задачи не сходятся. Скажи одной фразой, что и когда сделать.",
    uk: "Не зберіг: час і вид завдання не збігаються. Скажи однією фразою, що і коли зробити.",
    en: "Not saved: the time and the kind of task do not fit together. Say in one phrase what to do and when.",
  },
  schedule: {
    ru: "Не сохранил: не понял время. Назови дату и час, день или срок.",
    uk: "Не зберіг: не зрозумів час. Назви дату й годину, день або строк.",
    en: "Not saved: I did not understand the time. Give a date and a time, a day, or a deadline.",
  },
  recurrence: {
    ru: "Не сохранил повтор: такое расписание я выразить не могу. Скажи проще — например «каждый вторник в 19:00».",
    uk: "Не зберіг повтор: такий розклад я виразити не можу. Скажи простіше — наприклад «щовівторка о 19:00».",
    en: "Repeat not saved: I cannot express that schedule. Say it more simply, for example “every Tuesday at 19:00”.",
  },
  checklist: {
    ru: "Не сохранил чеклист: пункты пустые или повторяются.",
    uk: "Не зберіг чекліст: пункти порожні або повторюються.",
    en: "Checklist not saved: items are empty or repeated.",
  },
  reminder_anchor: {
    ru: "Не сохранил напоминание: у задачи нет даты, от которой его считать.",
    uk: "Не зберіг нагадування: у завдання немає дати, від якої його рахувати.",
    en: "Reminder not saved: the task has no date to count it from.",
  },
  new_task_state: {
    ru: "Задача, которую я создаю в этом же сообщении, ещё не существует: её нельзя завершить, отменить или отвязать в том же шаге. Скажи это следующим сообщением.",
    uk: "Завдання, яке я створюю в цьому ж повідомленні, ще не існує: його не можна завершити, скасувати чи відв'язати тим самим кроком. Скажи це наступним повідомленням.",
    en: "The task I am creating in this same message does not exist yet: it cannot be completed, cancelled or unlinked in the same step. Say that in your next message.",
  },
  series_time_mode: {
    ru: "Не изменил серию: у неё другой вид времени (например, срок вместо встречи). Назови время того же вида.",
    uk: "Не змінив серію: у неї інший вид часу (наприклад, дедлайн замість зустрічі). Назви час того ж виду.",
    en: "Series not changed: it uses a different kind of time (a deadline versus an appointment). Give a time of the same kind.",
  },
};

const BY_MESSAGE: ReadonlyArray<{ test: RegExp; code: string }> = [
  { test: /must not be in the past|must not be before today|reminder must be in the future/i, code: "time_past" },
  { test: /recurring item cannot use fuzzy time|fuzzy recurrence|cannot become fuzzy/i, code: "recurring_fuzzy" },
  { test: /missing or stale|stale or missing|changed while applying|stale/i, code: "stale" },
  { test: /already linked|duplicate|unique/i, code: "already_linked" },
  { test: /quiet hours/i, code: "quiet_hours" },
  { test: /reason is required/i, code: "reason_required" },
  { test: /terminal occurrence/i, code: "terminal_occurrence" },
  { test: /habit mode is not eligible|already offered|already a habit|habit mode requires a recurring/i, code: "habit_not_eligible" },
  { test: /settings are stale/i, code: "settings_stale" },
];

export function issueCode(issue: Pick<ActionIssue, "code" | "message">): string {
  if (BY_CODE[issue.code]) return issue.code;
  return BY_MESSAGE.find((entry) => entry.test.test(issue.message))?.code ?? issue.code;
}

/** Whether a code has a user-facing sentence; the chat layer logs the raw rule only when it does not. */
export function hasExplanation(code: string): boolean {
  return Boolean(BY_CODE[code]);
}

/** An unmapped rule gets a plain sentence; its English text goes to the log, never to the user. */
function genericRejection(locale: Locale): string {
  if (locale === "uk") return "Не зберіг: не спрацювало одне з правил. Сформулюй завдання й час одним реченням — або скажи, що саме зробити.";
  if (locale === "en") return "Not saved: one of the rules did not allow it. Restate the task and its time in one sentence, or tell me exactly what to do.";
  return "Не сохранил: не сработало одно из правил. Сформулируй задачу и время одной фразой — или скажи, что именно сделать.";
}

export function clarificationForCandidates(candidates: ReadonlyArray<{ title: string }>, language: string | null | undefined, question?: string): string {
  const locale = rejectionLocale(language);
  const titles = candidates
    .slice(0, 5)
    .map((candidate) => `«${candidate.title.trim().replace(/[«»]/g, "")}»`)
    .join(", ");
  if (question) return `${question} ${titles}.`.replace(/\?\s/u, "? ");
  if (locale === "uk") return `Бачу кілька варіантів: ${titles}. Який саме?`;
  if (locale === "en") return `I see several options: ${titles}. Which one do you mean?`;
  return `Вижу несколько вариантов: ${titles}. Какой именно?`;
}

export function unclearReply(language: string | null | undefined): string {
  const locale = rejectionLocale(language);
  if (locale === "uk") return "Не зрозумів. Скажи інакше: що зробити й коли.";
  if (locale === "en") return "I did not get that. Say it differently: what to do and when.";
  return "Не понял. Скажи иначе: что сделать и когда.";
}

/**
 * Deterministic reply for a turn whose actions cannot be applied. Nothing from the model's
 * prose is reused: the model already described a change that is not going to happen.
 */
export function renderValidationReply(issues: readonly ActionIssue[], language: string | null | undefined, actionCount: number): string {
  const locale = rejectionLocale(language);
  const prefix =
    actionCount > 1
      ? locale === "uk"
        ? "Нічого не застосував — дії з одного повідомлення застосовуються лише разом. "
        : locale === "en"
          ? "Nothing applied: actions from one message are applied only together. "
          : "Ничего не применил — действия из одного сообщения применяются только вместе. "
      : "";
  const ambiguous = issues.find((issue) => issue.kind === "ambiguous" && issue.candidates?.length);
  if (ambiguous) {
    const question =
      ambiguous.code === "scope_required"
        ? locale === "uk"
          ? "Це повторюване завдання. Скасувати лише це повторення чи всю серію?"
          : locale === "en"
            ? "That task repeats. Cancel only this occurrence or the whole series?"
            : "Это повторяющаяся задача. Отменить только это повторение или всю серию?"
        : undefined;
    return `${prefix}${question ?? clarificationForCandidates(ambiguous.candidates ?? [], language)}`;
  }
  const first = issues.find((issue) => issue.kind === "reference") ?? issues[0];
  if (!first) return `${prefix}${unclearReply(language)}`;
  const code = issueCode(first);
  const copy = BY_CODE[code];
  return `${prefix}${copy ? copy[locale] : genericRejection(locale)}`;
}
