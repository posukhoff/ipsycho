export function normalizeLanguageTag(value: string): string {
  const match = /^([a-z]{2})(?:-([a-z]{2}))?$/i.exec(value.trim());
  if (!match?.[1]) throw new Error("unsupported language format");
  const language = match[1].toLowerCase();
  const region = match[2]?.toUpperCase();
  return region ? `${language}-${region}` : language;
}
