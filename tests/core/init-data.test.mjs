import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { INIT_DATA_MAX_AGE_MS, verifyInitData } from "../../.core-dist/init-data.js";

/**
 * `initData` is the whole of the Mini App's transport security. On the bot side Telegram is the
 * channel; here one HMAC is all that stands between the internet and the allowlist.
 *
 * Every case below is a way a plausible implementation passes review and then fails, or worse,
 * accepts something it should not.
 */

const TOKEN = "123456:AA-test-bot-token-not-a-real-one";
const NOW = new Date("2026-09-05T12:00:00.000Z");
const AUTH_DATE = Math.floor(NOW.getTime() / 1000) - 60;

/** Telegram's own recipe, written out here so the test cannot inherit a bug from the code. */
function sign(fields, token = TOKEN) {
  const dataCheckString = Object.keys(fields)
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  return createHmac("sha256", secret).update(dataCheckString).digest("hex");
}

/** Percent-encoded by hand, so the test does not share `URLSearchParams` with the code it checks. */
function encode(fields, keyOrder = Object.keys(fields)) {
  return keyOrder.map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(fields[key]))}`).join("&");
}

function payload(overrides = {}) {
  return {
    user: JSON.stringify({ id: 4242, first_name: "Anna", language_code: "ru" }),
    chat_instance: "-1234567890123456789",
    chat_type: "sender",
    auth_date: String(AUTH_DATE),
    ...overrides,
  };
}

function signed(overrides = {}, keyOrder) {
  const fields = payload(overrides);
  const hash = sign(fields);
  const all = { ...fields, hash };
  return encode(all, keyOrder ? [...keyOrder, "hash"] : undefined);
}

test("a payload Telegram signed verifies, and only the id and language survive", () => {
  const result = verifyInitData(signed(), TOKEN, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.data.user.id, 4242);
  assert.equal(result.data.user.languageCode, "ru");
  assert.equal(result.data.authDate.getTime(), AUTH_DATE * 1000);
  assert.equal(result.data.startParam, null);
  // The name, username and photo are verified and then dropped, so nothing downstream can log them.
  assert.deepEqual(Object.keys(result.data.user).sort(), ["id", "languageCode"]);
  assert.ok(!JSON.stringify(result.data).includes("Anna"));
});

test("`signature` is part of the data-check string, not a second field to exclude", () => {
  // Bot API 8.0+ adds `signature`, the Ed25519 field a *third party* uses to validate without the
  // bot token. Its recipe excludes both `hash` and `signature`; ours excludes only `hash`. Copying
  // the wrong one makes every request from a modern client fail, and the plausible fix is to
  // loosen the check — so both directions are asserted.
  const fields = payload({ signature: "3-Q7QeQ1a2b3c4d5e6f7g8h9i0jklmnopqrstuvwxyz" });
  const correct = encode({ ...fields, hash: sign(fields) });
  assert.equal(verifyInitData(correct, TOKEN, NOW).ok, true);

  const withoutSignature = { ...fields };
  delete withoutSignature.signature;
  const thirdPartyRecipe = encode({ ...fields, hash: sign(withoutSignature) });
  assert.deepEqual(verifyInitData(thirdPartyRecipe, TOKEN, NOW), { ok: false, reason: "signature_mismatch" });
});

test("the order of the pairs on the wire does not matter, because the check sorts them", () => {
  const straight = verifyInitData(signed(), TOKEN, NOW);
  const shuffled = verifyInitData(signed({}, ["chat_type", "auth_date", "user", "chat_instance"]), TOKEN, NOW);
  assert.equal(straight.ok, true);
  assert.equal(shuffled.ok, true);
});

test("a tampered field, a wrong token and a changed user are all one refusal", () => {
  const fields = payload();
  const hash = sign(fields);

  const tampered = encode({ ...fields, user: JSON.stringify({ id: 9999, first_name: "Anna", language_code: "ru" }), hash });
  assert.deepEqual(verifyInitData(tampered, TOKEN, NOW), { ok: false, reason: "signature_mismatch" });

  // A field appended after signing: the classic "the app reads more than the check covers" bug.
  const appended = `${encode({ ...fields, hash })}&is_premium=true`;
  assert.deepEqual(verifyInitData(appended, TOKEN, NOW), { ok: false, reason: "signature_mismatch" });

  assert.deepEqual(verifyInitData(signed(), "999999:another-bot-token", NOW), { ok: false, reason: "signature_mismatch" });
});

test("a missing or wrong-length hash is a refusal, never a crash", () => {
  // `timingSafeEqual` throws on a length mismatch. Unguarded that is a 500 and a response
  // distinguishable from every other refusal, which is a free oracle.
  const fields = payload();
  assert.deepEqual(verifyInitData(encode(fields), TOKEN, NOW), { ok: false, reason: "hash_missing" });
  assert.deepEqual(verifyInitData(encode({ ...fields, hash: "" }), TOKEN, NOW), { ok: false, reason: "hash_missing" });

  const hash = sign(fields);
  for (const broken of [hash.slice(0, 63), `${hash}0`, hash.toUpperCase(), "not-hex".padEnd(64, "z"), "0x" + hash.slice(2)]) {
    assert.deepEqual(verifyInitData(encode({ ...fields, hash: broken }), TOKEN, NOW), { ok: false, reason: "hash_malformed" }, `hash ${broken.slice(0, 8)}…`);
  }
});

test("a duplicated key is refused rather than resolved", () => {
  // Nothing Telegram sends repeats a key. A duplicate is an attempt to have the check read one
  // value and the application another, and `URLSearchParams.get` quietly returns the first.
  const fields = payload();
  const raw = `${encode({ ...fields, hash: sign(fields) })}&auth_date=${AUTH_DATE}`;
  assert.deepEqual(verifyInitData(raw, TOKEN, NOW), { ok: false, reason: "malformed" });

  const duplicatedUser = `user=${encodeURIComponent(fields.user)}&${encode({ ...fields, hash: sign(fields) })}`;
  assert.deepEqual(verifyInitData(duplicatedUser, TOKEN, NOW), { ok: false, reason: "malformed" });
});

test("a newline cannot be used to merge two signed pairs into one", () => {
  // The data-check string joins the pairs with "\n", so replacing the `&` between two pairs that
  // are adjacent in *sorted* order produces one pair whose line is byte-identical to the two it
  // replaced. The hash still matches; the parsed map has silently lost a field. Every field this
  // code reads happens to be refused when it vanishes, so nothing is exploitable today — but the
  // signature must not verify a payload whose parse differs from what was signed.
  const fields = payload({ start_param: "task_1f2e3d" });
  const hash = sign(fields);
  const merged = encode({ ...fields, hash }).replace("&chat_type=", "\nchat_type=");
  assert.notEqual(merged, encode({ ...fields, hash }), "the mutation must actually change the string");
  assert.deepEqual(verifyInitData(merged, TOKEN, NOW), { ok: false, reason: "malformed" });

  // Merging `signature` into the pair before it would drop `start_param` from the map entirely.
  const dropped = encode({ ...fields, hash }).replace("&start_param=", "\nstart_param=");
  assert.deepEqual(verifyInitData(dropped, TOKEN, NOW), { ok: false, reason: "malformed" });

  // And a name that genuinely contains a newline still verifies: Telegram sends it as `%0A`, so it
  // never reaches this check as a literal.
  const multiline = signed({ user: JSON.stringify({ id: 11, first_name: "Anna\nKova", language_code: "en" }) });
  assert.ok(!multiline.includes("\n"), "encodeURIComponent must have escaped it");
  const result = verifyInitData(multiline, TOKEN, NOW);
  assert.equal(result.ok, true, "an escaped newline inside a value is ordinary signed data");
  assert.equal(result.data.user.id, 11);
});

test("a non-ASCII name verifies, and so does one containing a literal percent sign", () => {
  // `URLSearchParams` has already decoded the values. Decoding a second time turns "%41" into "A"
  // and the signature stops matching — for that one user, forever, and invisibly, because a log
  // that correctly refuses to record the payload cannot show why.
  const cyrillic = signed({ user: JSON.stringify({ id: 7, first_name: "Анна Ковальчук", language_code: "uk" }) });
  assert.equal(verifyInitData(cyrillic, TOKEN, NOW).ok, true);

  const emoji = signed({ user: JSON.stringify({ id: 8, first_name: "Anna 🌿", language_code: "en" }) });
  assert.equal(verifyInitData(emoji, TOKEN, NOW).ok, true);

  const percent = signed({ user: JSON.stringify({ id: 9, first_name: "Anna %41 %20 100%", language_code: "en" }) });
  const result = verifyInitData(percent, TOKEN, NOW);
  assert.equal(result.ok, true, "a literal % in a name must not break verification");
  assert.equal(result.data.user.id, 9);
});

test("an `auth_date` older than a day is refused, and one that is merely old is not", () => {
  const stale = Math.floor((NOW.getTime() - INIT_DATA_MAX_AGE_MS - 1000) / 1000);
  assert.deepEqual(verifyInitData(signed({ auth_date: String(stale) }), TOKEN, NOW), { ok: false, reason: "expired" });

  const almost = Math.floor((NOW.getTime() - INIT_DATA_MAX_AGE_MS + 60_000) / 1000);
  assert.equal(verifyInitData(signed({ auth_date: String(almost) }), TOKEN, NOW).ok, true);

  const fields = payload();
  delete fields.auth_date;
  assert.deepEqual(verifyInitData(encode({ ...fields, hash: sign(fields) }), TOKEN, NOW), { ok: false, reason: "auth_date_missing" });
  assert.deepEqual(verifyInitData(signed({ auth_date: "later" }), TOKEN, NOW), { ok: false, reason: "auth_date_malformed" });
});

test("an absent `user` is a refusal, not a reason to look somewhere else", () => {
  // Telegram sends empty `initData` for keyboard-button and inline launches. There is no fallback:
  // `initDataUnsafe`, a body field and a header are all caller-controlled, and accepting any of
  // them turns the signature check into decoration.
  const fields = payload();
  delete fields.user;
  assert.deepEqual(verifyInitData(encode({ ...fields, hash: sign(fields) }), TOKEN, NOW), { ok: false, reason: "user_missing" });
  assert.deepEqual(verifyInitData(signed({ user: "" }), TOKEN, NOW), { ok: false, reason: "user_missing" });

  assert.deepEqual(verifyInitData(signed({ user: "{not json" }), TOKEN, NOW), { ok: false, reason: "user_malformed" });
  assert.deepEqual(verifyInitData(signed({ user: "[]" }), TOKEN, NOW), { ok: false, reason: "user_malformed" });
  for (const id of ['"4242"', "0", "-1", "1.5", "null"]) {
    assert.deepEqual(verifyInitData(signed({ user: `{"id":${id}}` }), TOKEN, NOW), { ok: false, reason: "user_malformed" }, `id ${id}`);
  }
});

test("empty and oversized input are refused before any work is done", () => {
  assert.deepEqual(verifyInitData("", TOKEN, NOW), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyInitData("x".repeat(9000), TOKEN, NOW), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyInitData("garbage", TOKEN, NOW), { ok: false, reason: "hash_missing" });
  assert.deepEqual(verifyInitData(signed(), "", NOW), { ok: false, reason: "signature_mismatch" });
});

test("meaning is checked after the signature, so an unsigned payload cannot probe the rules", () => {
  // An expired *unsigned* payload must read as a bad signature, not as "expired": otherwise the
  // refusal tells a stranger which half of their forgery to work on next.
  const fields = payload({ auth_date: "1" });
  const raw = encode({ ...fields, hash: sign(payload()) });
  assert.deepEqual(verifyInitData(raw, TOKEN, NOW), { ok: false, reason: "signature_mismatch" });
});

test("`start_param` comes back as a routing hint and nothing more", () => {
  const result = verifyInitData(signed({ start_param: "task_1f2e3d" }), TOKEN, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.data.startParam, "task_1f2e3d");
});
