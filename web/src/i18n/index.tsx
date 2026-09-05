import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ApiRequestError } from "../api/client.js";
import type { ApiErrorCode, Locale } from "../api/contracts.js";
import { en } from "./en.js";
import { ru } from "./ru.js";
import { uk } from "./uk.js";

/**
 * The client dictionary and the resolution rule.
 *
 * The rule is the server's, repeated exactly (`telegramLocale` in `src/telegram/telegram-locale.ts`):
 * a pinned language wins, else Telegram's `language_code`, else English. It is repeated rather than
 * imported because importing `src/telegram/**` would pull the bot's copy — and grammY — into the
 * browser bundle (design.md § 6).
 *
 * The app resolves the locale twice: once from Telegram alone, so the loading screen and the
 * «open me from Telegram» screen are already in the right language before `/me` answers, and again
 * from `settings.pinnedLanguage` once it does.
 */

export type CopyKey = keyof typeof ru;

const DICTIONARIES: Record<Locale, Record<CopyKey, string>> = { ru, uk, en };

export const LOCALES: readonly Locale[] = ["ru", "uk", "en"];

/** Pinned language → Telegram `language_code` → English. */
export function resolveLocale(pinnedLanguage?: Locale | null, telegramLanguage?: string | null): Locale {
  const value = (pinnedLanguage ?? telegramLanguage ?? "en").toLowerCase();
  if (value.startsWith("uk")) return "uk";
  if (value.startsWith("ru")) return "ru";
  return "en";
}

export type TranslateParams = Readonly<Record<string, string | number>>;

export function translate(locale: Locale, key: CopyKey, params: TranslateParams = {}): string {
  const template = DICTIONARIES[locale][key];
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => (name in params ? String(params[name]) : match));
}

export type PluralNoun = "task" | "day" | "date" | "goal" | "reminder";

const PLURALS: Record<Locale, Record<PluralNoun, readonly [string, string, string]>> = {
  ru: {
    task: ["задача", "задачи", "задач"],
    day: ["день", "дня", "дней"],
    date: ["дата", "даты", "дат"],
    goal: ["цель", "цели", "целей"],
    reminder: ["напоминание", "напоминания", "напоминаний"],
  },
  uk: {
    task: ["завдання", "завдання", "завдань"],
    day: ["день", "дні", "днів"],
    date: ["дата", "дати", "дат"],
    goal: ["ціль", "цілі", "цілей"],
    reminder: ["нагадування", "нагадування", "нагадувань"],
  },
  en: {
    task: ["task", "tasks", "tasks"],
    day: ["day", "days", "days"],
    date: ["date", "dates", "dates"],
    goal: ["goal", "goals", "goals"],
    reminder: ["reminder", "reminders", "reminders"],
  },
};

/** The Slavic three-form rule; English collapses to singular/plural. Mirrors the server's `plural`. */
export function pluralForm(locale: Locale, count: number, noun: PluralNoun): string {
  const forms = PLURALS[locale][noun];
  if (locale === "en") return count === 1 ? forms[0] : forms[2];
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export interface Translator {
  (key: CopyKey, params?: TranslateParams): string;
  readonly locale: Locale;
  /** `3 задачи` — the count with the noun in the right form. */
  readonly plural: (count: number, noun: PluralNoun) => string;
  /** The user-facing sentence for a failed request; never the server's diagnostic message. */
  readonly error: (error: unknown) => string;
}

/**
 * The i18n key for an API failure.
 *
 * The server sends a closed `code` and a fixed English sentence meant for a network log
 * (`API_ERROR_MESSAGES`). The user reads this instead. A `TypeError` from `fetch` is the webview
 * losing its connection, which is a different sentence from a 500.
 */
const ERROR_KEYS: Record<ApiErrorCode, CopyKey> = {
  validation_failed: "error.validation_failed",
  unauthorized: "error.unauthorized",
  forbidden: "error.forbidden",
  not_found: "error.not_found",
  conflict: "error.conflict",
  domain_rule: "error.domain_rule",
  consent_required: "error.consent_required",
  rate_limited: "error.rate_limited",
  unavailable: "error.unavailable",
  internal: "error.internal",
};

export function errorCopyKey(error: unknown): CopyKey {
  if (error instanceof ApiRequestError) return ERROR_KEYS[error.code];
  // A `TypeError` out of `fetch` is the webview losing its connection, not a server refusal.
  if (error instanceof TypeError) return "error.offline";
  return "error.internal";
}

export function createTranslator(locale: Locale): Translator {
  const translator = ((key: CopyKey, params?: TranslateParams) => translate(locale, key, params)) as {
    (key: CopyKey, params?: TranslateParams): string;
    locale: Locale;
    plural: (count: number, noun: PluralNoun) => string;
    error: (error: unknown) => string;
  };
  translator.locale = locale;
  translator.plural = (count, noun) => `${count} ${pluralForm(locale, count, noun)}`;
  translator.error = (error) => translate(locale, errorCopyKey(error));
  return translator;
}

const I18nContext = createContext<Translator>(createTranslator("en"));

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }): ReactNode {
  const translator = useMemo(() => createTranslator(locale), [locale]);
  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

/** `const t = useT(); t("task.why")`. Also carries `t.locale`, `t.plural` and `t.error`. */
export function useT(): Translator {
  return useContext(I18nContext);
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}

export { en, ru, uk };
