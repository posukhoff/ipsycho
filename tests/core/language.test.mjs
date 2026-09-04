import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLanguageTag, detectMessageLocale, languageName } from "../../.core-dist/language.js";

test("language tags normalize language and optional region casing", () => {
  assert.equal(normalizeLanguageTag("UK-ua"), "uk-UA");
  assert.equal(normalizeLanguageTag("ru"), "ru");
  assert.throws(() => normalizeLanguageTag("uk_UA"), /unsupported language format/);
});

test("the reply language is read from the script of the message, not from the account", () => {
  assert.equal(detectMessageLocale("Напомни через четыре часа посмотреть курс"), "ru");
  assert.equal(detectMessageLocale("Створи задачу: у середу зателефонувати до банку"), "ru", "no Ukrainian-only letter, so the script cannot tell");
  assert.equal(detectMessageLocale("Add a task for tomorrow at 9am"), "en");
  // Ukrainian needs one of its own letters; the two languages share the rest of the alphabet, so
  // «Це вже зроблено» reads as Russian here and the account language settles it upstream.
  assert.equal(detectMessageLocale("Це вже зроблено"), "ru");
  assert.equal(detectMessageLocale("Створи задачу: зателефонувати до банку і записати відповідь"), "uk");
  // Too little to tell: the caller falls back to the account language.
  assert.equal(detectMessageLocale("ok"), null);
  assert.equal(detectMessageLocale("12:30"), null);
});

test("locale names are the English words the prompt puts in front of the model", () => {
  assert.equal(languageName("ru"), "Russian");
  assert.equal(languageName("uk"), "Ukrainian");
  assert.equal(languageName("en"), "English");
});
