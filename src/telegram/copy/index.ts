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
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => (name in params ? String(params[name]) : match));
}

export type PluralNoun = "task" | "date" | "deed";

/** Count with the right plural form: `plural(locale, 3, "task")` → "3 задачи". */
export function plural(locale: TelegramLocale, count: number, noun: PluralNoun): string {
  return `${count} ${pluralForm(locale, count, noun)}`;
}

/** The noun alone, for a line that already prints the count. */
export function pluralForm(locale: TelegramLocale, count: number, noun: PluralNoun): string {
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
    task: ["задача", "задачи", "задач"],
    date: ["дата", "даты", "дат"],
    deed: ["дело", "дела", "дел"],
  },
  uk: {
    task: ["завдання", "завдання", "завдань"],
    date: ["дата", "дати", "дат"],
    deed: ["справа", "справи", "справ"],
  },
  en: {
    task: ["task", "tasks", "tasks"],
    date: ["date", "dates", "dates"],
    deed: ["task", "tasks", "tasks"],
  },
} as const satisfies Record<TelegramLocale, Record<string, readonly [string, string, string]>>;
