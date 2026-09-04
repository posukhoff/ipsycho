/**
 * Turns a user message into a PostgreSQL `to_tsquery('simple', …)` string.
 *
 * The `simple` configuration neither stems nor drops stop words, and `websearch_to_tsquery`
 * ANDs every word: «Напомни про таблетки завтра утром» became
 * `'напомни' & 'про' & 'таблетки' & 'завтра' & 'утром'`, which no stored task or note ever
 * matched. Here the message is reduced to its content words, each shortened to a prefix so
 * inflected forms still match («посылку» → `посыл:*` matches «посылка»), and the prefixes are
 * OR-ed; ranking then puts rows matching several words first.
 */

const MAX_TERMS = 12;
const MIN_TERM_LENGTH = 3;

const STOP_WORDS = new Set(`
и в во на не что он она с со как а то все всё так его но да ты к у же вы за бы по только её ее мне было вот от меня ещё еще нет о из ему
теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть
надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь
этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти
нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно
всю между это эта этих мои моих наш наша наше наши свой своя свои
сегодня завтра послезавтра вчера утром вечером днём днем ночью час часа часов минут минуты минуту неделе неделю неделя месяц месяца
понедельник вторник среда среду четверг пятница пятницу суббота субботу воскресенье время
напомни напомнить напоминание напоминания перенеси перенести создай создать добавь добавить удали удалить отмени отменить сделай сделать
поставь поставить запиши записать покажи показать измени изменить давай нужно хочу пожалуйста задача задачу задачи задачей дело дела
і у із як він вона але ти ж ви б тільки її мені ось від мене ще немає ему тепер коли навіть чи якщо вже або бути був нього знову адже
потім себе нічого їй може вони де є треба ми тебе їх ніж сам щоб чого теж собі буде тоді хто цей тому цього який зовсім ним цьому
майже мій тим зараз були куди навіщо всіх ніколи можна нарешті інший хоч після більше той ці всього них яка багато цю моя добре свою цій
іноді краще трохи такий їм завжди звичайно всю між це ця
сьогодні завтра післязавтра вчора вранці ввечері вдень вночі година години годин хвилин хвилини тиждень тижня місяць
нагадай нагадати нагадування перенеси перенести створи створити додай додати видали видалити скасуй скасувати зроби зробити постав
поставити запиши записати покажи показати зміни змінити давай потрібно треба хочу завдання справа справи
the a an and or but if then of to in on at for with from by about as into like through after over between out against during without
before under around among i me my we our you your he him his she her it its they them their what which who whom this that these those
am is are was were be been being have has had do does did will would shall should can could may might must not no yes so than too very
just also now here there when where why how all any both each few more most other some such only own same up down off again further once
today tomorrow yesterday morning evening night hour hours minute minutes week month monday tuesday wednesday thursday friday saturday sunday
remind reminder reschedule move create add delete remove cancel make set note show change please need want task tasks
`.split(/\s+/u).filter(Boolean));

/** Content words of a message: lowercase, no stop words, no numbers, no very short tokens. */
export function searchTerms(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < MIN_TERM_LENGTH || /^\p{N}+$/u.test(raw) || STOP_WORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

/**
 * A prefix long enough to be specific and short enough to cover the word's inflections.
 * «посылку» → «посыл», «врачу» → «врач», «маме» → «мам», «созвон» → «созво».
 */
export function searchPrefix(term: string): string {
  if (term.length >= 7) return term.slice(0, term.length - 2);
  if (term.length >= 4) return term.slice(0, term.length - 1);
  return term;
}

/** The `to_tsquery('simple', …)` argument for a message, or null when it has no content words. */
export function tsQueryFor(text: string): string | null {
  const terms = searchTerms(text);
  if (!terms.length) return null;
  return [...new Set(terms.map(searchPrefix))].map((prefix) => `${prefix}:*`).join(" | ");
}
