#!/usr/bin/env bash
# Proves a backup can actually be restored: dump the database at DATABASE_URL, encrypt it exactly
# as the production runner does, decrypt, restore into a scratch database, and compare the row
# count of every table. CI runs this against the e2e database; a greped script is not a backup.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ipsycho-roundtrip.XXXXXX")"
chmod 711 "$WORK"
SCRATCH_DB="ipsycho_roundtrip_$$"
ADMIN_URL="${DATABASE_URL%/*}/postgres"
RESTORE_URL="${DATABASE_URL%/*}/$SCRATCH_DB"

# pg_dump refuses to talk to a newer server, and a runner's client is often a major behind the
# database it tests. When the local client is too old (or missing), the client tools run inside an
# image that matches the server. The work directory is mounted at its own path, so no argument
# needs rewriting.
PG_CLIENT_IMAGE="${PG_CLIENT_IMAGE:-postgres:17-alpine}"
PG_DOCKER_NETWORK="${PG_DOCKER_NETWORK:-host}"

client_major() {
  command -v pg_dump >/dev/null 2>&1 || return 1
  pg_dump --version | sed -nE 's/.* ([0-9]+).*/\1/p'
}

server_major() {
  local url="$1"
  if command -v psql >/dev/null 2>&1; then
    psql "$url" --tuples-only --no-align --command "show server_version_num" 2>/dev/null | cut -c1-2
  else
    docker run --rm --network "$PG_DOCKER_NETWORK" "$PG_CLIENT_IMAGE" psql "$url" --tuples-only --no-align --command "show server_version_num" 2>/dev/null | cut -c1-2
  fi
}

LOCAL_MAJOR="$(client_major || true)"
SERVER_MAJOR="$(server_major "$DATABASE_URL" || true)"
if [ -n "$LOCAL_MAJOR" ] && [ -n "$SERVER_MAJOR" ] && [ "$LOCAL_MAJOR" -ge "$SERVER_MAJOR" ]; then
  pg() { "$@"; }
  printf 'using local postgres client %s against server %s\n' "$LOCAL_MAJOR" "$SERVER_MAJOR" >&2
else
  command -v docker >/dev/null 2>&1 || { echo "no postgres client new enough for the server and no docker to run one" >&2; exit 1; }
  pg() { docker run --rm --network "$PG_DOCKER_NETWORK" --volume "$WORK:$WORK" "$PG_CLIENT_IMAGE" "$@"; }
  printf 'using %s for the client tools (local client %s, server %s)\n' "$PG_CLIENT_IMAGE" "${LOCAL_MAJOR:-none}" "${SERVER_MAJOR:-unknown}" >&2
fi

cleanup() {
  status=$?
  trap - EXIT INT TERM
  pg psql "$ADMIN_URL" --quiet --command "drop database if exists $SCRATCH_DB" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT INT TERM

openssl rand -base64 48 > "$WORK/key"
pg pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$WORK/raw.dump"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass "file:$WORK/key" -in "$WORK/raw.dump" -out "$WORK/backup.enc"
# openssl is already required here, and unlike sha256sum it exists on both Linux and macOS.
openssl dgst -sha256 -r "$WORK/backup.enc" | cut -d" " -f1 > "$WORK/backup.enc.sha256"
[ "$(openssl dgst -sha256 -r "$WORK/backup.enc" | cut -d" " -f1)" = "$(cat "$WORK/backup.enc.sha256")" ] || { echo "checksum mismatch right after writing the backup" >&2; exit 1; }
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$WORK/key" -in "$WORK/backup.enc" -out "$WORK/restored.dump"
cmp "$WORK/raw.dump" "$WORK/restored.dump"

pg psql "$ADMIN_URL" --quiet --command "create database $SCRATCH_DB" >/dev/null
pg pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname="$RESTORE_URL" "$WORK/restored.dump"

# One row per table, "name=count", compared as a whole. Row counts are what a restore has to
# reproduce; the schema is already proven by pg_restore --exit-on-error.
MANIFEST_SQL="select string_agg(format('%s=%s', table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text), ',' order by table_name) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"
manifest() {
  pg psql "$1" --tuples-only --no-align --command "$MANIFEST_SQL"
}

SOURCE_COUNTS="$(manifest "$DATABASE_URL")"
RESTORED_COUNTS="$(manifest "$RESTORE_URL")"
if [ "$SOURCE_COUNTS" != "$RESTORED_COUNTS" ]; then
  echo "row counts differ after restore" >&2
  echo "source:   $SOURCE_COUNTS" >&2
  echo "restored: $RESTORED_COUNTS" >&2
  exit 1
fi
TABLES="$(pg psql "$RESTORE_URL" --tuples-only --no-align --command "select count(*) from pg_tables where schemaname='public'")"
[ "$TABLES" -gt 10 ] || { echo "restored database has only $TABLES public tables" >&2; exit 1; }

printf 'backup_roundtrip_ok tables=%s\n' "$TABLES"
