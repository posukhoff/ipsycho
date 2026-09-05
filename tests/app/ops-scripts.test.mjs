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
