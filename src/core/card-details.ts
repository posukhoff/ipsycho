/**
 * Which optional task fields deserve a line on a card.
 *
 * why / nextAction / context are written by the model and stored as-is. A card shows them
 * next to the title, checklist and goal, so a field earns its line only when it adds
 * information those lines do not already carry. Repetitions ("Позвонить маме" →
 * "Следующий шаг: позвонить маме") and planning chores that the application itself
 * performs ("поставить напоминание") are dropped here, which also cleans up tasks stored
 * before the prompt learned the same rules.
 */
export interface CardDetailInput {
  title: string;
  why?: string | null;
  nextAction?: string | null;
  context?: string | null;
  checklist?: ReadonlyArray<{ text: string; done: boolean }> | null;
  goalTitle?: string | null;
}

export interface CardDetails {
  why: string | null;
  nextAction: string | null;
  context: string | null;
}

export function selectCardDetails(task: CardDetailInput): CardDetails {
  const title = task.title.trim();
  const goal = task.goalTitle?.trim() ?? "";
  const checklist = (task.checklist ?? []).map((item) => item.text.trim()).filter(Boolean);

  const keptWhy = keepSentences(task.why, [title, goal]);

  const nextAction = clean(task.nextAction);
  const keptNextAction = nextAction
    && !looksLikePlanningChore(nextAction) && !looksLikeSchedulingEcho(nextAction)
    // A checklist already is the ordered list of steps; a next step that draws on it adds nothing.
    && !isRedundantText(nextAction, [title, keptWhy ?? "", ...checklist])
    ? nextAction : null;

  const keptContext = keepSentences(task.context, [title, keptWhy ?? "", keptNextAction ?? "", goal, ...checklist]);

  return { why: keptWhy, nextAction: keptNextAction, context: keptContext };
}

/**
 * why/context are often several sentences where only one adds something ("Сегодня вакцинация
 * в 18:00. Есть отдельное напоминание через год. Клиника на Лесной."). Judge each sentence on
 * its own and keep the informative ones.
 */
function keepSentences(value: string | null | undefined, references: readonly string[]): string | null {
  const text = clean(value);
  if (!text) return null;
  const sentences = text.split(/(?<=[.!?;])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  const kept = sentences.filter((sentence) => !looksLikeSchedulingEcho(sentence) && !isRedundantText(sentence, references));
  return kept.length ? kept.join(" ") : null;
}

/**
 * True when `candidate` says nothing beyond `references`: it is contained in one of them
 * (or contains one), or most of its meaningful words already occur across them.
 */
export function isRedundantText(candidate: string, references: readonly string[]): boolean {
  const normalized = normalize(candidate);
  if (!normalized) return true;
  const present = references.map(normalize).filter(Boolean);
  if (!present.length) return false;
  // Containment counts both ways, but a short reference ("Сон") must not swallow a longer sentence that merely mentions it.
  if (present.some((reference) => reference.includes(normalized) || (reference.length >= 12 && normalized.includes(reference)))) return true;
  const words = stems(normalized);
  if (!words.length) return true;
  const known = new Set(present.flatMap(stems));
  const shared = words.filter((word) => known.has(word)).length;
  return shared / words.length >= 0.5;
}

const PLANNING_CHORE = /(?:поставить|установить|настроить|добавить|создать|завести|записать)\s+(?:себе\s+)?(?:напоминани|задач|событи|в\s+календар|в\s+список)|напомнить\s+себе|запланировать\s+(?:задач|это|её|его|время|дату)|^запланировать(?!\p{L})|открыть\s+(?:это\s+|этот\s+)?(?:приложени|бот|список|календар)|выбрать\s+(?:время|дату)|решить,?\s+когда|set\s+(?:a\s+|the\s+)?reminder|add\s+(?:a\s+)?(?:task|reminder|calendar)|schedule\s+(?:it|this|the\s+task)|open\s+the\s+app/iu;

/** A next step the application already performs for the user is not a next step. */
export function looksLikePlanningChore(text: string): boolean {
  return PLANNING_CHORE.test(text.trim());
}

// `\b` is ASCII-only in JS regexes, so Cyrillic word ends are expressed as (?!\p{L}).
// "Чтобы не забыть/не пропустить X" is the reminder's own purpose, never the user's reason for X.
const SCHEDULING_ECHO = /^(?:чтобы\s+)?(?:не\s+(?:забыть|пропустить|упустить|опоздать)(?!\p{L})|напомнить\s+(?:себе|мне|о|об|про)(?!\p{L})|вспомнить(?!\p{L}))|^(?:это\s+|есть\s+)?(?:(?:контрольное|отдельное|повторное|новое|дополнительное)\s+)*напоминани[еяюи](?!\p{L})|^запланирован[оаы]?(?!\p{L})|^(?:щоб\s+)?(?:не\s+забути|нагадати)(?!\p{L})|^нагадування(?!\p{L})|^(?:to\s+)?(?:remember|remind\s+me)(?!\p{L})|^(?:a\s+|the\s+)?reminder(?!\p{L})|^scheduled\s+(?:for|on|at)(?!\p{L})/iu;

/**
 * "Чтобы напомнить о вакцинации через год", "Контрольное напоминание ровно через год в 10:00",
 * "Запланировано на вечер": the field talks about the reminder or the schedule, which the
 * card already shows, not about the user's reason or circumstances. Catches fields written
 * for an earlier title, where plain word overlap is too low.
 */
export function looksLikeSchedulingEcho(text: string): boolean {
  return SCHEDULING_ECHO.test(text.trim());
}

const STOP_WORDS = new Set([
  "и", "а", "но", "в", "во", "на", "с", "со", "к", "ко", "по", "о", "об", "от", "до", "из", "за", "у", "для", "чтобы", "что", "как", "не", "ни", "же", "ли", "бы",
  "это", "этот", "эта", "эти", "тот", "та", "те", "так", "там", "тут", "через", "после", "перед", "при", "про", "без", "над", "под", "или", "его", "её", "ее", "их", "мой", "моя", "мои", "свой", "своя", "свои",
  "та", "ті", "це", "цей", "ця", "ці", "щоб", "який", "яка", "які", "або", "чи", "із", "зі", "від", "під", "над", "через", "після", "перед", "для", "про", "без",
  "the", "a", "an", "to", "of", "and", "or", "for", "with", "in", "on", "at", "by", "from", "is", "it", "this", "that", "my", "be",
  // Time words carry nothing the schedule line does not already show.
  "ровно", "сегодня", "завтра", "послезавтра", "утром", "днем", "вечером", "ночью", "год", "года", "году", "лет", "день", "дня", "дней", "неделя", "неделю", "недели", "месяц", "месяца", "час", "часа", "часов", "мин", "минут",
  "сьогодні", "завтра", "вранці", "ввечері", "рік", "року", "тиждень", "тижня", "місяць", "годин", "хвилин",
  "today", "tomorrow", "morning", "evening", "year", "week", "month", "day", "hour", "hours", "minutes",
  "понедельник", "вторник", "среда", "среду", "четверг", "пятница", "пятницу", "суббота", "субботу", "воскресенье",
  "понеділок", "вівторок", "середа", "середу", "четвер", "п'ятниця", "п'ятницю", "субота", "суботу", "неділя", "неділю",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  // Generic verbs say nothing without their object: "подготовить и отправить отчёт" is the title "Отчёт" in verb form.
  "сделать", "делать", "выполнить", "выполнять", "подготовить", "подготовиться", "провести", "проверить", "отправить", "начать", "закончить", "завершить", "заняться", "пройти", "сходить", "съездить", "нужно", "нужна", "нужен", "нужны", "надо",
  "зробити", "робити", "виконати", "підготувати", "провести", "перевірити", "надіслати", "почати", "закінчити", "завершити", "пройти", "треба", "потрібно",
  "do", "make", "prepare", "send", "start", "finish", "complete", "check", "go", "need",
]);

function clean(value: string | null | undefined): string | null {
  const text = value?.trim().replace(/\s+/g, " ") ?? "";
  return text || null;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** Crude prefix stemming so "прививка"/"прививок" and "позвонить"/"позвоню" count as one word. */
function stems(normalized: string): string[] {
  return normalized.split(" ")
    .filter((word) => word.length > 2 && !/^\d+$/.test(word) && !STOP_WORDS.has(word))
    .map((word) => (word.length > 4 ? word.slice(0, 4) : word));
}
