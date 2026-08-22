export type TelegramLocale = "en" | "ru" | "uk";

/** A pinned language wins; otherwise follow the language configured in Telegram. */
export function telegramLocale(pinnedLanguage?: string | null, telegramLanguage?: string): TelegramLocale {
  const value = (pinnedLanguage ?? telegramLanguage ?? "en").toLowerCase();
  if (value.startsWith("uk")) return "uk";
  if (value.startsWith("ru")) return "ru";
  return "en";
}
