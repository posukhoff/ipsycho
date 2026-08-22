import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLanguageTag } from "../../.core-dist/language.js";

test("language tags normalize language and optional region casing", () => {
  assert.equal(normalizeLanguageTag("UK-ua"), "uk-UA");
  assert.equal(normalizeLanguageTag("ru"), "ru");
  assert.throws(() => normalizeLanguageTag("uk_UA"), /unsupported language format/);
});
