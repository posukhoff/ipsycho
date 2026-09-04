import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../../dist/database/schema.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required; run npm run test:e2e");

const pool = new Pool({ connectionString: url });
after(async () => {
  await pool.end();
});

function declaredTables() {
  return Object.values(schema)
    .filter((value) => is(value, PgTable))
    .map((table) => getTableConfig(table));
}

test("every table the migrations create is declared in schema.ts, and vice versa", async () => {
  const { rows } = await pool.query("select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations' and tablename not like 'pgboss%'");
  const inDatabase = new Set(rows.map((row) => row.tablename));
  const inCode = new Set(declaredTables().map((table) => table.name));
  assert.deepEqual(
    [...inDatabase].filter((name) => !inCode.has(name)),
    [],
    "tables exist in the database but not in schema.ts",
  );
  assert.deepEqual(
    [...inCode].filter((name) => !inDatabase.has(name)),
    [],
    "tables declared in schema.ts do not exist in the database",
  );
});

/**
 * Drizzle only ever reads through this schema today, but `drizzle-kit generate` writes migrations
 * from it. An index or a foreign key that exists only in SQL means a generated migration would try
 * to create it again; one that exists only in TypeScript means it was never applied.
 */
test("index names match between the database and schema.ts", async () => {
  const { rows } = await pool.query(
    "select tablename, indexname from pg_indexes where schemaname = 'public' and tablename not like 'pgboss%' and tablename <> 'schema_migrations'",
  );
  // A UNIQUE constraint and an index both show up in pg_indexes; schema.ts expresses the first as
  // unique() and the second as index(), so both sides are compared as one set of names.
  const declared = new Map(
    declaredTables().map((table) => [table.name, new Set([...table.indexes.map((index) => index.config.name), ...table.uniqueConstraints.map((unique) => unique.name)])]),
  );
  const primaryKeyLike = /_pkey$/;
  const missingInCode = [];
  const missingInDatabase = [];
  const inDatabase = new Map();
  for (const row of rows) {
    if (primaryKeyLike.test(row.indexname)) continue;
    if (!inDatabase.has(row.tablename)) inDatabase.set(row.tablename, new Set());
    inDatabase.get(row.tablename).add(row.indexname);
  }
  for (const [table, names] of inDatabase) {
    const code = declared.get(table) ?? new Set();
    for (const name of names) if (!code.has(name)) missingInCode.push(`${table}.${name}`);
  }
  for (const [table, names] of declared) {
    const database = inDatabase.get(table) ?? new Set();
    for (const name of names) if (!database.has(name)) missingInDatabase.push(`${table}.${name}`);
  }
  assert.deepEqual(missingInCode, [], "indexes in the database that schema.ts does not declare");
  assert.deepEqual(missingInDatabase, [], "indexes declared in schema.ts that the database does not have");
});

test("foreign keys and their delete behaviour match between the database and schema.ts", async () => {
  const { rows } = await pool.query(`
    select c.conrelid::regclass::text as table_name, c.confrelid::regclass::text as target, c.confdeltype as on_delete, array_length(c.conkey, 1) as columns
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where c.contype = 'f' and n.nspname = 'public' and t.relname not like 'pgboss%'`);
  const inDatabase = rows.map((row) => `${row.table_name}->${row.target}/${row.columns}/${row.on_delete}`).sort();
  const inCode = declaredTables()
    .flatMap((table) => {
      return table.foreignKeys.map((key) => {
        const reference = key.reference();
        const target = getTableConfig(reference.foreignTable).name;
        const onDelete = key.onDelete === "cascade" ? "c" : key.onDelete === "set null" ? "n" : "a";
        return `${table.name}->${target}/${reference.columns.length}/${onDelete}`;
      });
    })
    .sort();
  const counted = (list) => {
    const map = new Map();
    for (const item of list) map.set(item, (map.get(item) ?? 0) + 1);
    return map;
  };
  const database = counted(inDatabase);
  const code = counted(inCode);
  const onlyInDatabase = [...database].filter(([key, count]) => (code.get(key) ?? 0) < count).map(([key]) => key);
  const onlyInCode = [...code].filter(([key, count]) => (database.get(key) ?? 0) < count).map(([key]) => key);
  assert.deepEqual(onlyInDatabase, [], "foreign keys in the database that schema.ts does not declare (or declares with a different ON DELETE)");
  assert.deepEqual(onlyInCode, [], "foreign keys declared in schema.ts that the database does not have");
});
