import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

for (const script of ["scripts/backup-compose.sh", "scripts/restore-compose.sh", "scripts/deploy-remote.sh", "scripts/dev.sh"]) {
  test(`${script} has valid bash syntax`, () => {
    execFileSync("bash", ["-n", script], { stdio: "pipe" });
  });
}

test("Compose backup publishes only a fully validated encrypted file", () => {
  const source = readFileSync("scripts/backup-compose.sh", "utf8");
  assert.match(source, /pg_restore --list/);
  assert.match(source, /mv "\$ENC_TMP" "\$ENC"/);
  assert.match(source, /S3_BACKUP_URI must start with s3:\/\//);
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
});
