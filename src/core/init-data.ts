import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Telegram Mini App `initData` verification.
 *
 * This is the whole of the allowlist's transport security: on the bot side Telegram *is* the
 * channel, on the web side a signature check is all that stands between the internet and
 * `AccessService`. So it is a pure function with no I/O, tested on its own in
 * `tests/core/init-data.test.mjs`.
 *
 * The algorithm (Bot API, "Validating data received via the Mini App"):
 *
 *   secret        = HMAC_SHA256(key = "WebAppData", message = <bot token>)
 *   data-check    = every `key=value` pair except `hash`, sorted by key, joined with "\n"
 *   valid         = HMAC_SHA256(key = secret, message = data-check) == hash
 *
 * Four details that every wrong implementation gets wrong, and each of which fails only against a
 * real client:
 *
 * 1. `signature` (Bot API 8.0+) is **part of the data-check string**. It is the Ed25519 field a
 *    *third party* uses to validate without the bot token, and the third-party recipe excludes it
 *    along with `hash`. Copying that recipe here makes every request from a modern client fail,
 *    and the plausible-looking fix is to loosen the check. Only `hash` is excluded, and there is no
 *    Ed25519 fallback: one algorithm, one answer.
 * 2. `timingSafeEqual` throws on a length mismatch. A 63-character `hash` would then be a 500 and a
 *    response distinguishable from an ordinary refusal, so the hash is validated as 64 lowercase
 *    hex characters first and the comparison only ever sees two 32-byte buffers.
 * 3. `URLSearchParams` has already percent-decoded every value. Decoding a second time corrupts a
 *    name containing a literal `%` — the signature then fails for that one user, forever, and the
 *    cause is invisible from a log that (correctly) does not record the payload.
 * 4. An absent `user` is a refusal. Telegram sends empty `initData` for keyboard-button and inline
 *    launches, and there is no fallback: not `initDataUnsafe`, not a body field, not a header.
 *    Anything but the verified map is caller-controlled.
 */

/** The signature stays valid for a day. It bounds a *stolen* payload; it is not revocation. */
export const INIT_DATA_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** Telegram's own payload is a few hundred bytes. This only bounds the work a stranger can ask for. */
const MAX_RAW_LENGTH = 8_192;

const SECRET_KEY_SALT = "WebAppData";
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const AUTH_DATE_PATTERN = /^\d{1,15}$/u;
const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u;

/**
 * Why a payload was refused. These are fixed tokens, safe to log and deliberately never shown to
 * the caller: the API answers all of them with one `unauthorized`, so the endpoint cannot be used
 * to learn which part of a forgery was wrong.
 */
export type InitDataRejection =
  "malformed" | "hash_missing" | "hash_malformed" | "signature_mismatch" | "auth_date_missing" | "auth_date_malformed" | "expired" | "user_missing" | "user_malformed";

/**
 * Deliberately not the Telegram user object.
 *
 * `first_name`, `last_name`, `username` and `photo_url` are verified along with everything else and
 * then dropped here, so that no caller can log or echo them by accident. The id is traded for the
 * internal uuid immediately; the language code is the same fallback the bot middleware uses.
 */
export interface InitDataUser {
  id: number;
  languageCode: string | null;
}

export interface VerifiedInitData {
  user: InitDataUser;
  authDate: Date;
  /**
   * `start_param` is attacker-influenced whenever a launch link is shared. It is a navigation hint
   * and nothing else; server-side workspace scoping is what turns a foreign id into a not-found.
   */
  startParam: string | null;
}

export type InitDataResult = { ok: true; data: VerifiedInitData } | { ok: false; reason: InitDataRejection };

/**
 * Verifies `initData` and returns the little of it that the server is allowed to use.
 *
 * The order is: shape, then signature, then meaning. Everything semantic — the age, the presence of
 * a user — is checked *after* the HMAC, so an unsigned payload cannot be used to probe what the
 * server would have accepted.
 */
export function verifyInitData(raw: string, botToken: string, now: Date = new Date()): InitDataResult {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_LENGTH) return { ok: false, reason: "malformed" };
  // A literal newline in the *raw* string, before decoding, is delimiter injection: the data-check
  // string joins the pairs with "\n", so replacing an `&` with a newline merges two pairs into one
  // whose `key=value` line is byte-identical to the two it replaced — and the signature still
  // matches while the parsed map has lost a field. Nothing downstream can be fooled today (a
  // vanished `auth_date` or `user` is a refusal, and `hash` would stop being 64 hex), but the safety
  // rests on a chain of unrelated checks. Telegram percent-encodes every value, so a name that
  // really contains a newline arrives as `%0A` and still verifies; a bare one never does.
  if (raw.includes("\n")) return { ok: false, reason: "malformed" };
  if (typeof botToken !== "string" || botToken.length === 0) return { ok: false, reason: "signature_mismatch" };

  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  for (const [key, value] of new URLSearchParams(raw)) {
    // Telegram never repeats a key. A duplicate is either a proxy artefact or an attempt to have
    // the check read one value and the application another, and there is no safe way to pick.
    if (seen.has(key)) return { ok: false, reason: "malformed" };
    seen.add(key);
    pairs.push([key, value]);
  }

  const hash = valueOf(pairs, "hash");
  if (hash === null || hash === "") return { ok: false, reason: "hash_missing" };
  if (!HASH_PATTERN.test(hash)) return { ok: false, reason: "hash_malformed" };

  // Only `hash` is dropped. `signature`, when the client sends one, is signed data like any other.
  const dataCheckString = pairs
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", SECRET_KEY_SALT).update(botToken).digest();
  const expected = createHmac("sha256", secretKey).update(dataCheckString).digest();
  // Both are 32 bytes: `expected` by construction, `hash` because it matched HASH_PATTERN above.
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return { ok: false, reason: "signature_mismatch" };

  const authDateRaw = valueOf(pairs, "auth_date");
  if (authDateRaw === null || authDateRaw === "") return { ok: false, reason: "auth_date_missing" };
  if (!AUTH_DATE_PATTERN.test(authDateRaw)) return { ok: false, reason: "auth_date_malformed" };
  const authDate = new Date(Number(authDateRaw) * 1_000);
  if (!Number.isFinite(authDate.getTime())) return { ok: false, reason: "auth_date_malformed" };
  // A future `auth_date` is server clock skew, not forgery: it is inside the signature. Only age is
  // a security bound, so only age is enforced.
  if (now.getTime() - authDate.getTime() > INIT_DATA_MAX_AGE_MS) return { ok: false, reason: "expired" };

  const user = parseUser(valueOf(pairs, "user"));
  if (user === "missing") return { ok: false, reason: "user_missing" };
  if (user === "malformed") return { ok: false, reason: "user_malformed" };

  return { ok: true, data: { user, authDate, startParam: valueOf(pairs, "start_param") } };
}

function valueOf(pairs: readonly (readonly [string, string])[], key: string): string | null {
  return pairs.find(([candidate]) => candidate === key)?.[1] ?? null;
}

function parseUser(raw: string | null): InitDataUser | "missing" | "malformed" {
  if (raw === null || raw === "") return "missing";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "malformed";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "malformed";
  const source = parsed as { id?: unknown; language_code?: unknown };
  if (typeof source.id !== "number" || !Number.isSafeInteger(source.id) || source.id <= 0) return "malformed";
  const languageCode = typeof source.language_code === "string" && LANGUAGE_CODE_PATTERN.test(source.language_code) ? source.language_code.slice(0, 16) : null;
  return { id: source.id, languageCode };
}
