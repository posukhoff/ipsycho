import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "../../dist/database/migrations-runner.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required; run npm run test:e2e");

// The runner is exercised against its own ledger table so the real schema_migrations stays intact.
const pool = new Pool({ connectionString: url });
let client;

before(async () => {
  client = await pool.connect();
  await client.query("drop table if exists mig_probe; drop table if exists mig_probe2");
  await client.query("alter table schema_migrations rename to schema_migrations_real");
});

after(async () => {
  await client.query("drop table if exists schema_migrations");
  await client.query("alter table schema_migrations_real rename to schema_migrations");
  await client.query("drop table if exists mig_probe; drop table if exists mig_probe2");
  client.release();
  await pool.end();
});

test("an edited migration is refused, a new one is applied, and legacy rows get their checksum backfilled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ipsycho-mig-"));
  await writeFile(join(dir, "0001_probe.sql"), "create table mig_probe (id int primary key);\n");
  const first = await runMigrations(client, dir);
  assert.deepEqual(first.applied, ["0001_probe.sql"]);

  await client.query("update schema_migrations set checksum = null where name = '0001_probe.sql'");
  const second = await runMigrations(client, dir);
  assert.deepEqual(second, { applied: [], backfilled: ["0001_probe.sql"] });

  await writeFile(join(dir, "0001_probe.sql"), "create table mig_probe (id int primary key, edited boolean);\n");
  await assert.rejects(() => runMigrations(client, dir), /edited after it was applied/);

  await writeFile(join(dir, "0001_probe.sql"), "create table mig_probe (id int primary key);\n");
  await writeFile(join(dir, "0002_probe.sql"), "-- no-transaction\ncreate index concurrently mig_probe_id_idx on mig_probe(id);\n");
  const third = await runMigrations(client, dir);
  assert.deepEqual(third.applied, ["0002_probe.sql"]);
  const { rows } = await client.query("select name, checksum from schema_migrations order by name");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum)));
});

test("a failing transactional migration leaves no trace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ipsycho-mig-"));
  await writeFile(join(dir, "0001_bad.sql"), "create table mig_probe2 (id int); insert into mig_probe2 values ('x');\n");
  await assert.rejects(() => runMigrations(client, dir));
  const tables = await client.query("select 1 from pg_tables where tablename = 'mig_probe2'");
  assert.equal(tables.rowCount, 0);
  const ledger = await client.query("select 1 from schema_migrations where name = '0001_bad.sql'");
  assert.equal(ledger.rowCount, 0);
});
