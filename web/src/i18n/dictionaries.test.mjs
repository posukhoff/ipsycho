import assert from "node:assert/strict";
import test from "node:test";
import { en } from "./en.ts";
import { ru } from "./ru.ts";
import { uk } from "./uk.ts";

/**
 * The three dictionaries have the same keys, the same placeholders, and no empty string.
 *
 * The type system already refuses a missing or extra key — `uk` and `en` are declared as
 * `Record<keyof typeof ru, string>`, and an object literal with a key that is not in that record is
 * an excess-property error — so `npm run check:web` fails on drift without running anything. This
 * test is the runtime half: it catches what types cannot, which is a translation that dropped a
 * `{placeholder}` the screen is going to pass, or a key translated to an empty string.
 *
 * Run: `node --test web/src/i18n/dictionaries.test.mjs` (Node 24 strips the types on import).
 */

const DICTIONARIES = { ru, uk, en };

function placeholders(template) {
  return [...template.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
}

test("every dictionary has exactly the keys of the reference", () => {
  const reference = Object.keys(ru).sort();
  for (const [name, dictionary] of Object.entries(DICTIONARIES)) {
    assert.deepEqual(Object.keys(dictionary).sort(), reference, `${name} does not have the same keys as ru`);
  }
});

test("a key means the same thing in every language", () => {
  for (const key of Object.keys(ru)) {
    const expected = placeholders(ru[key]);
    for (const [name, dictionary] of Object.entries(DICTIONARIES)) {
      assert.deepEqual(placeholders(dictionary[key]), expected, `${name}.${key} does not carry the same placeholders as ru.${key}`);
    }
  }
});

test("no translation is empty", () => {
  for (const [name, dictionary] of Object.entries(DICTIONARIES)) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, "string", `${name}.${key} is not a string`);
      assert.ok(value.trim().length > 0, `${name}.${key} is empty`);
    }
  }
});
