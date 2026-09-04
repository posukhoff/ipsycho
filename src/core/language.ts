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
