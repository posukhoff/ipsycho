import type { TelegramLocale } from "../telegram-locale.js";
import { en } from "./en.js";
import { ru } from "./ru.js";
import { uk } from "./uk.js";

export type CopyKey = keyof typeof ru;

const DICTIONARIES: Record<TelegramLocale, Record<CopyKey, string>> = { ru, uk, en };

/**
 * One string in the user's locale. Every key exists in all three dictionaries by type: a
 * string added to `ru` without its `uk` and `en` counterparts does not compile. `{name}`
 * placeholders are filled from `params`.
 */
export function t(locale: TelegramLocale, key: CopyKey, params: Record<string, string | number> = {}): string {
  const template = DICTIONARIES[locale][key];
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => name in params ? String(params[name]) : match);
}

/** Count with the right plural form: `plural(locale, 3, "task")` → "3 задачи". */
export function plural(locale: TelegramLocale, count: number, noun: "task" | "message" | "point" | "day" | "week" | "month" | "goal" | "step"): string {
  const forms = PLURALS[locale][noun];
  return `${count} ${pickForm(locale, count, forms)}`;
}

/** The noun alone in the form that fits `count`; for sentences that place the number elsewhere. */
export function pluralNoun(locale: TelegramLocale, count: number, noun: keyof typeof PLURALS["ru"]): string {
  return pickForm(locale, count, PLURALS[locale][noun]);
}

function pickForm(locale: TelegramLocale, count: number, forms: readonly [string, string, string]): string {
  if (locale === "en") return count === 1 ? forms[0] : forms[2];
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

const PLURALS = {
  ru: {
    task: ["задача", "задачи", "задач"], message: ["сообщение", "сообщения", "сообщений"], point: ["пункт", "пункта", "пунктов"],
    day: ["день", "дня", "дней"], week: ["неделю", "недели", "недель"], month: ["месяц", "месяца", "месяцев"], goal: ["цель", "цели", "целей"], step: ["шаг", "шага", "шагов"],
  },
  uk: {
    task: ["завдання", "завдання", "завдань"], message: ["повідомлення", "повідомлення", "повідомлень"], point: ["пункт", "пункти", "пунктів"],
    day: ["день", "дні", "днів"], week: ["тиждень", "тижні", "тижнів"], month: ["місяць", "місяці", "місяців"], goal: ["ціль", "цілі", "цілей"], step: ["крок", "кроки", "кроків"],
  },
  en: {
    task: ["task", "tasks", "tasks"], message: ["message", "messages", "messages"], point: ["item", "items", "items"],
    day: ["day", "days", "days"], week: ["week", "weeks", "weeks"], month: ["month", "months", "months"], goal: ["goal", "goals", "goals"], step: ["step", "steps", "steps"],
  },
} as const satisfies Record<TelegramLocale, Record<string, readonly [string, string, string]>>;
