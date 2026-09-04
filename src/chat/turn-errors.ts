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

/** The raw rule keeps an unmapped failure debuggable instead of silently generic. */
function technicalHint(message: string): string {
  const raw = message.replace(/\s+/gu, " ").trim();
  return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
}

function genericRejection(locale: Locale, message: string): string {
  const hint = technicalHint(message);
  if (locale === "uk") return `Не зберіг: зібрана дія не пройшла перевірку правил${hint ? ` (${hint})` : ""}. Сформулюй завдання й час одним реченням — або скажи, що саме зробити.`;
  if (locale === "en") return `Not saved: the action I assembled failed a domain rule${hint ? ` (${hint})` : ""}. Restate the task and its time in one sentence, or tell me exactly what to do.`;
  return `Не сохранил: собранное действие не прошло проверку правил${hint ? ` (${hint})` : ""}. Сформулируй задачу и время одной фразой — или скажи, что именно сделать.`;
}

export function clarificationForCandidates(candidates: ReadonlyArray<{ title: string }>, language: string | null | undefined, question?: string): string {
  const locale = rejectionLocale(language);
  const titles = candidates.slice(0, 5).map((candidate) => `«${candidate.title.trim().replace(/[«»]/g, "")}»`).join(", ");
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
  const prefix = actionCount > 1
    ? locale === "uk" ? "Нічого не застосував — дії з одного повідомлення застосовуються лише разом. "
      : locale === "en" ? "Nothing applied: actions from one message are applied only together. "
      : "Ничего не применил — действия из одного сообщения применяются только вместе. "
    : "";
  const ambiguous = issues.find((issue) => issue.kind === "ambiguous" && issue.candidates?.length);
  if (ambiguous) {
    const question = ambiguous.code === "scope_required"
      ? locale === "uk" ? "Це повторюване завдання. Скасувати лише це повторення чи всю серію?"
        : locale === "en" ? "That task repeats. Cancel only this occurrence or the whole series?"
        : "Это повторяющаяся задача. Отменить только это повторение или всю серию?"
      : undefined;
    return `${prefix}${question ?? clarificationForCandidates(ambiguous.candidates ?? [], language)}`;
  }
  const first = issues.find((issue) => issue.kind === "reference") ?? issues[0];
  if (!first) return `${prefix}${unclearReply(language)}`;
  const code = issueCode(first);
  const copy = BY_CODE[code];
  return `${prefix}${copy ? copy[locale] : genericRejection(locale, first.message)}`;
}
