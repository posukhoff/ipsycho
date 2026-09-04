import "dotenv/config";
import "reflect-metadata";
import { resolve } from "node:path";
import { Pool } from "pg";
import { runMigrations } from "./migrations-runner.js";

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
  // A DDL statement waiting behind a long query would otherwise block every other session on that table.
  await client.query("set lock_timeout = '5s'");
  await client.query("select pg_advisory_lock($1, $2)", [LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
  migrationLockHeld = true;
  const appLock = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1, $2) as locked", [LOCK_NAMESPACE, APP_LOCK_KEY]);
  appExclusionLockHeld = appLock.rows[0]?.locked === true;
  if (!appExclusionLockHeld) throw new Error("stop the active IPsycho app before running database migrations");
  await runMigrations(client, resolve(process.cwd(), "migrations"));
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
