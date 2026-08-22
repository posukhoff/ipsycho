import "dotenv/config";
import "reflect-metadata";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
const LOCK_NAMESPACE = 424242;
const MIGRATION_LOCK_KEY = 105;
const APP_LOCK_KEY = 106;
let migrationLockHeld = false;
let appExclusionLockHeld = false;
try {
  await client.query("select pg_advisory_lock($1, $2)", [LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
  migrationLockHeld = true;
  const appLock = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1, $2) as locked", [LOCK_NAMESPACE, APP_LOCK_KEY]);
  appExclusionLockHeld = appLock.rows[0]?.locked === true;
  if (!appExclusionLockHeld) throw new Error("stop the active IPsycho app before running database migrations");
  await client.query(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const dir = resolve(process.cwd(), "migrations");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    const exists = await client.query("select 1 from schema_migrations where name = $1", [name]);
    if (exists.rowCount) continue;
    const sql = await readFile(resolve(dir, name), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations(name) values ($1)", [name]);
      await client.query("commit");
      console.log(`applied ${name}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  if (appExclusionLockHeld) {
    await client.query("select pg_advisory_unlock($1, $2)", [LOCK_NAMESPACE, APP_LOCK_KEY]).catch(() => undefined);
  }
  if (migrationLockHeld) {
    await client.query("select pg_advisory_unlock($1, $2)", [LOCK_NAMESPACE, MIGRATION_LOCK_KEY]).catch(() => undefined);
  }
  client.release();
  await pool.end();
}
