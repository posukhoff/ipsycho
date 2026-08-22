import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

for (const script of ["scripts/backup-compose.sh", "scripts/restore-compose.sh"]) {
  test(`${script} has valid POSIX shell syntax`, () => {
    execFileSync("sh", ["-n", script], { stdio: "pipe" });
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
  assert.doesNotMatch(source, /docker compose exec[^\n]*postgres[^\n]*pg_restore/);
});
