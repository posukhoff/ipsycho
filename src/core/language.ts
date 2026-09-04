export function normalizeLanguageTag(value: string): string {
  const match = /^([a-z]{2})(?:-([a-z]{2}))?$/i.exec(value.trim());
  if (!match?.[1]) throw new Error("unsupported language format");
  const language = match[1].toLowerCase();
  const region = match[2]?.toUpperCase();
  return region ? `${language}-${region}` : language;
}

export type InterfaceLocale = "ru" | "uk" | "en";

/** The interface locale for a stored or Telegram language tag; Russian when unknown. */
export function interfaceLocale(language: string | null | undefined): InterfaceLocale {
  const value = language?.trim().toLowerCase() ?? "";
  if (value.startsWith("uk")) return "uk";
  if (value.startsWith("en")) return "en";
  return "ru";
}

const LANGUAGE_NAMES: Record<InterfaceLocale, string> = { ru: "Russian", uk: "Ukrainian", en: "English" };

/**
 * Which language the user just wrote in, by script: Ukrainian-only letters (і, ї, є, ґ) win over
 * Cyrillic, and anything else is Latin. Deliberately crude, and it cannot separate Ukrainian from
 * Russian in a sentence that happens to use none of those four letters — the caller settles that
 * with the account language. It decides one line of the prompt, nothing else.
 */
export function detectMessageLocale(text: string): InterfaceLocale | null {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length < 3) return null;
  if (/[іїєґ]/iu.test(text)) return "uk";
  const cyrillic = (letters.match(/[\u0400-\u04FF]/gu) ?? []).length;
  const latin = (letters.match(/[A-Za-z]/gu) ?? []).length;
  if (cyrillic === 0 && latin === 0) return null;
  if (cyrillic > latin) return "ru";
  if (latin > cyrillic) return "en";
  return null;
}

/** The English name of a locale, for the one prompt line that tells the model which language to answer in. */
export function languageName(locale: InterfaceLocale): string {
  return LANGUAGE_NAMES[locale];
}
