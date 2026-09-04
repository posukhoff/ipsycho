import test from "node:test";
import assert from "node:assert/strict";
import { searchPrefix, searchTerms, tsQueryFor } from "../../.core-dist/search-query.js";

test("a message is reduced to its content words: no stop words, command verbs, dates or numbers", () => {
  assert.deepEqual(searchTerms("Напомни про таблетки завтра утром в 16:00"), ["таблетки"]);
  assert.deepEqual(searchTerms("Перенеси созвон с дизайнером на понедельник"), ["созвон", "дизайнером"]);
  assert.deepEqual(searchTerms("Нагадай про посилку у вівторок"), ["посилку", "вівторок"]);
  assert.deepEqual(searchTerms("remind me to call the dentist tomorrow"), ["call", "dentist"]);
  assert.deepEqual(searchTerms("да"), []);
  assert.deepEqual(searchTerms("   "), []);
});

test("prefixes cover inflected forms without becoming too short", () => {
  assert.equal(searchPrefix("посылку"), "посыл");
  assert.equal(searchPrefix("таблетки"), "таблет");
  assert.equal(searchPrefix("дизайнером"), "дизайнер");
  assert.equal(searchPrefix("врачу"), "врач");
  assert.equal(searchPrefix("маме"), "мам");
  assert.equal(searchPrefix("кот"), "кот");
});

test("the tsquery ORs prefix lexemes and is null for a message with no content words", () => {
  assert.equal(tsQueryFor("Напомни про таблетки завтра утром"), "таблет:*");
  assert.equal(tsQueryFor("Перенеси созвон с дизайнером на понедельник в 16:00"), "созво:* | дизайнер:*");
  assert.equal(tsQueryFor("ок, давай"), null);
  // Terms sharing a prefix collapse to one lexeme.
  assert.equal(tsQueryFor("посылка посылку"), "посыл:*");
});

test("the query never contains tsquery syntax characters from the message", () => {
  const query = tsQueryFor("что-то & странное | (в скобках) 'кавычки' !нет");
  assert.ok(query);
  for (const lexeme of query.split(" | ")) assert.match(lexeme, /^[\p{L}\p{N}]+:\*$/u);
});
