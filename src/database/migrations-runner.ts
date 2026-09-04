import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { logger } from "../observability/logger.js";

/**
 * Migration files are applied once, in name order, each inside its own transaction. The runner
 * records a sha256 of every applied file: editing an applied migration is refused, because
 * re-running it silently is exactly how `0010` and `0018` would destroy data. Rows recorded before
 * checksums existed are backfilled on the first run (trust on first use).
 *
 * A file whose first line is `-- no-transaction` runs outside a transaction; PostgreSQL requires
 * that for `CREATE INDEX CONCURRENTLY`.
 */
export const NO_TRANSACTION_MARKER = "-- no-transaction";

export async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  await client.query("alter table schema_migrations add column if not exists checksum text");
}

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export async function runMigrations(client: PoolClient, dir: string): Promise<{ applied: string[]; backfilled: string[] }> {
  await ensureMigrationsTable(client);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const applied: string[] = [];
  const backfilled: string[] = [];
  for (const name of files) {
    const sql = await readFile(resolve(dir, name), "utf8");
    const checksum = migrationChecksum(sql);
    const existing = await client.query<{ checksum: string | null }>("select checksum from schema_migrations where name = $1", [name]);
    const row = existing.rows[0];
    if (row) {
      if (row.checksum === null) {
        await client.query("update schema_migrations set checksum = $2 where name = $1", [name, checksum]);
        backfilled.push(name);
      } else if (row.checksum !== checksum) {
        throw new Error(`migration ${name} was edited after it was applied (recorded ${row.checksum.slice(0, 12)}, file ${checksum.slice(0, 12)}); add a new migration instead`);
      }
      continue;
    }
    const inTransaction = !sql.trimStart().startsWith(NO_TRANSACTION_MARKER);
    if (inTransaction) await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations(name, checksum) values ($1, $2)", [name, checksum]);
      if (inTransaction) await client.query("commit");
      logger.info("migration applied", { name, inTransaction });
      applied.push(name);
    } catch (error) {
      if (inTransaction) await client.query("rollback").catch(() => undefined);
      throw error;
    }
  }
  return { applied, backfilled };
}
