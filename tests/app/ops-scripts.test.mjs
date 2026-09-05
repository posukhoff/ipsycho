import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

for (const script of [
  "scripts/backup-compose.sh",
  "scripts/restore-compose.sh",
  "scripts/deploy-remote.sh",
  "scripts/dev.sh",
  "scripts/backup-roundtrip.sh",
  "scripts/watchdog.sh",
]) {
  test(`${script} has valid bash syntax`, () => {
    execFileSync("bash", ["-n", script], { stdio: "pipe" });
  });
}

test("Compose backup publishes only a fully validated encrypted file", () => {
  const source = readFileSync("scripts/backup-compose.sh", "utf8");
  assert.match(source, /pg_restore --list/);
  assert.match(source, /mv "\$ENC_TMP" "\$ENC"/);
  assert.match(source, /S3_BACKUP_URI must start with s3:\/\//);
  // Without a bucket the backup still runs and stays local; the log says so plainly.
  assert.match(source, /S3_BACKUP_URI="\$\{S3_BACKUP_URI:-\}"/);
  assert.match(source, /the encrypted copy stays on this machine only/);
  assert.match(source, /offsite=%s/);
});

test("Compose restore drill uses a disposable container, never production postgres", () => {
  const source = readFileSync("scripts/restore-compose.sh", "utf8");
  assert.match(source, /docker run --detach/);
  assert.match(source, /docker rm -f/);
  assert.match(source, /--exit-on-error --single-transaction/);
  assert.doesNotMatch(source, /docker compose exec[^\n]*postgres[^\n]*pg_restore/);
});

test("the remote deploy only succeeds once /ready reports the deployed commit, and rolls back otherwise", () => {
  const source = readFileSync("scripts/deploy-remote.sh", "utf8");
  assert.match(source, /PREVIOUS_SHA="\$\(git rev-parse HEAD\)"/);
  assert.match(source, /pg_dump[^\n]*pre-deploy|PRE_DEPLOY_DIR/);
  assert.match(source, /--wait --wait-timeout/);
  assert.match(source, /wait_ready "\$DEPLOY_SHA"/);
  assert.match(source, /git checkout --detach "\$PREVIOUS_SHA"/);
  assert.doesNotMatch(source, /image prune/);
  // The dump's tight umask must not reach the checkout: files the image cannot read fail the boot.
  assert.match(source, /\(\n\s+umask 077/);
  assert.doesNotMatch(source, /^umask 077$/mu);
  // A rollback target may predate /ready, so the check falls back to /health.
  assert.match(source, /3000\/health/);
});

test("the round-trip drill restores into a scratch database and compares row counts", () => {
  const source = readFileSync("scripts/backup-roundtrip.sh", "utf8");
  assert.match(source, /create database \$SCRATCH_DB/);
  assert.match(source, /drop database if exists \$SCRATCH_DB/);
  assert.match(source, /row counts differ after restore/);
  assert.doesNotMatch(source, /drop database if exists "?\$\{?DATABASE_URL/);
  // A runner's client is often a major behind the service container, and pg_dump refuses that.
  assert.match(source, /PG_CLIENT_IMAGE/);
  assert.match(source, /pg pg_dump /);
  assert.doesNotMatch(source, /^pg_dump /mu);
  // sha256sum does not exist everywhere; openssl is already a requirement of this script.
  assert.match(source, /openssl dgst -sha256/);
  assert.doesNotMatch(source, /^\s*sha256sum /mu);
});

test("the image makes what the non-root runtime reads readable, whatever the checkout's umask was", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const chmod = dockerfile.indexOf("chmod -R a+rX");
  const user = dockerfile.indexOf("USER node");
  assert.ok(chmod > 0, "the runtime stage must normalise permissions");
  assert.ok(chmod < user, "permissions are fixed while the build is still root");
  for (const path of ["./migrations", "./dist", "./package.json"]) assert.ok(dockerfile.slice(chmod, user).includes(path), path);
});

test("the watchdog alerts once per outage and never puts the bot token on a command line", () => {
  const source = readFileSync("scripts/watchdog.sh", "utf8");
  // One message when the failures cross the threshold, one when it recovers; not every tick.
  assert.match(source, /if \[ "\$state" -eq "\$FAILURES_BEFORE_ALERT" \]/);
  assert.match(source, /снова отвечает/);
  // Telegram puts the token in the URL, and a URL in argv is readable through `ps`: the whole
  // request goes to curl on stdin instead, and the token is never echoed.
  assert.match(source, /curl[^\n]*--config -/);
  assert.doesNotMatch(source, /curl[^\n]*https:\/\/api\.telegram\.org/);
  assert.doesNotMatch(source, /echo[^\n]*\$token/);
});

/**
 * The edge is the only part of the deployment the internet can reach, and every property below has
 * a failure mode that looks like a fix: a catch-all `reverse_proxy` publishes `/health`, an
 * `X-Frame-Options` line makes the app blank on web.telegram.org, and `'unsafe-inline'` turns an
 * XSS into full account control because the API is same-origin with no cookie. design.md §§ 6, 8, 9.
 */
test("the edge publishes only /app and /api/v1, and frames the app only for Telegram", () => {
  const caddyfile = readFileSync("Caddyfile", "utf8");
  /** Comments explain what is deliberately absent, so a prose mention must not read as a directive. */
  const directives = caddyfile.replace(/^\s*#.*$/gmu, "");

  // Nothing is proxied except through the `to_app` snippet, and every import of it sits inside a
  // handle with a path matcher. Caddy answers an unmatched path with an empty 200, so a catch-all
  // would publish /health and /ready — the commit SHA, the database state and the loop names.
  const proxies = [...caddyfile.matchAll(/^\s*reverse_proxy\s+(.*)$/gmu)].map((match) => match[1].trim());
  assert.deepEqual(proxies, ["app:3000 {"], "the only reverse_proxy is the one inside (to_app)");
  assert.match(caddyfile, /handle\s*\{\s*\n\s*respond 404/u, "the final handle must refuse, not fall through");
  for (const path of ["/health", "/ready"]) assert.ok(!directives.includes(`handle ${path}`), `${path} must not be routed`);

  // `/app*` also matches `/apple`, which the app answers with Nest's own 404 — a body that quotes
  // the requested path back. The matcher names the two forms it means.
  assert.match(caddyfile, /@app path \/app \/app\/\*/u);
  assert.ok(!/handle\s+\/app\*/u.test(caddyfile), "a bare /app* glob matches /apple too");

  // The client IP is replaced, never appended, and the client's own forwarding headers are dropped.
  // `main.ts` trusts exactly one hop, so the value that survives here is what the limiter keys on.
  assert.match(caddyfile, /header_up X-Forwarded-For \{client_ip\}/u);
  assert.match(caddyfile, /header_up -X-Real-IP/u);
  assert.match(caddyfile, /header_up -Forwarded/u);
  assert.ok(!directives.includes("trusted_proxies"), "Caddy is the edge: it must trust no client-supplied forwarding header");

  const csp = /Content-Security-Policy "([^"]+)"/u.exec(caddyfile)?.[1];
  assert.ok(csp, "the app must carry a CSP");
  assert.match(csp, /frame-ancestors https:\/\/web\.telegram\.org https:\/\/\*\.telegram\.org/u);
  assert.ok(!/script-src[^;]*unsafe-inline/u.test(csp), "an XSS in the app is full account control");
  assert.ok(!/script-src[^;]*unsafe-eval/u.test(csp));
  assert.match(csp, /default-src 'none'/u);
  assert.match(csp, /base-uri 'none'/u);
  // `DENY` is the line in every security-headers snippet and it makes the app blank in Telegram Web.
  assert.ok(!directives.includes("X-Frame-Options"), "framing is restricted by frame-ancestors, never by X-Frame-Options");

  // The admin socket is an unauthenticated config-write API; the access log would record
  // `Authorization: tma <initDataRaw>`, a bearer credential for the whole account.
  assert.match(caddyfile, /^\s*admin off/mu);
  assert.match(caddyfile, /log \{\s*\n\s*output discard/u);
  // Mirrors JSON_BODY_LIMIT in main.ts, so an oversized body dies at the edge.
  assert.match(caddyfile, /max_size 64KB/u);
});
