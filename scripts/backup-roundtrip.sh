#!/usr/bin/env bash
# Proves a backup can actually be restored: dump the database at DATABASE_URL, encrypt it exactly
# as the production runner does, decrypt, restore into a scratch database, and compare the row
# count of every table. CI runs this against the e2e database; a greped script is not a backup.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ipsycho-roundtrip.XXXXXX")"
SCRATCH_DB="ipsycho_roundtrip_$$"
ADMIN_URL="${DATABASE_URL%/*}/postgres"
RESTORE_URL="${DATABASE_URL%/*}/$SCRATCH_DB"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  psql "$ADMIN_URL" --quiet --command "drop database if exists $SCRATCH_DB" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT INT TERM

openssl rand -base64 48 > "$WORK/key"
pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$WORK/raw.dump"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass "file:$WORK/key" -in "$WORK/raw.dump" -out "$WORK/backup.enc"
(cd "$WORK" && sha256sum backup.enc > backup.enc.sha256 && sha256sum -c backup.enc.sha256 >/dev/null)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$WORK/key" -in "$WORK/backup.enc" -out "$WORK/restored.dump"
cmp "$WORK/raw.dump" "$WORK/restored.dump"

psql "$ADMIN_URL" --quiet --command "create database $SCRATCH_DB" >/dev/null
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname="$RESTORE_URL" "$WORK/restored.dump"

# One row per table, "name=count", compared as a whole. Row counts are what a restore has to
# reproduce; the schema is already proven by pg_restore --exit-on-error.
MANIFEST_SQL="select string_agg(format('%s=%s', table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text), ',' order by table_name) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"
manifest() {
  psql "$1" --tuples-only --no-align --command "$MANIFEST_SQL"
}

SOURCE_COUNTS="$(manifest "$DATABASE_URL")"
RESTORED_COUNTS="$(manifest "$RESTORE_URL")"
if [ "$SOURCE_COUNTS" != "$RESTORED_COUNTS" ]; then
  echo "row counts differ after restore" >&2
  echo "source:   $SOURCE_COUNTS" >&2
  echo "restored: $RESTORED_COUNTS" >&2
  exit 1
fi
TABLES="$(psql "$RESTORE_URL" --tuples-only --no-align --command "select count(*) from pg_tables where schemaname='public'")"
[ "$TABLES" -gt 10 ] || { echo "restored database has only $TABLES public tables" >&2; exit 1; }

printf 'backup_roundtrip_ok tables=%s\n' "$TABLES"
