#!/usr/bin/env sh
set -eu

# Safe restore drill: decrypt an encrypted Compose backup and restore it into a
# temporary PostgreSQL container. The production database is never connected.
umask 077
: "${1:?usage: scripts/restore-compose.sh <encrypted-backup>}"
: "${BACKUP_KEY_FILE:?BACKUP_KEY_FILE is required}"

INPUT="$1"
[ -r "$INPUT" ] || { echo "backup file is not readable: $INPUT" >&2; exit 1; }
[ -r "$BACKUP_KEY_FILE" ] || { echo "BACKUP_KEY_FILE must be readable" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

RAW="$(mktemp "${TMPDIR:-/tmp}/ipsycho-restore-check.XXXXXX.dump")"
CONTAINER="ipsycho-restore-check-$$"
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  rm -f "$RAW"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$INPUT" -out "$RAW"
docker run --detach --name "$CONTAINER" \
  --env POSTGRES_DB=ipsycho_restore \
  --env POSTGRES_USER=ipsycho_restore \
  --env POSTGRES_PASSWORD=restore-check-only \
  postgres:17-alpine >/dev/null

ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if docker exec "$CONTAINER" pg_isready --username=ipsycho_restore --dbname=ipsycho_restore >/dev/null 2>&1; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$ready" -eq 1 ] || { echo "temporary restore database did not become ready" >&2; exit 1; }

docker cp "$RAW" "$CONTAINER:/tmp/backup.dump"
docker exec "$CONTAINER" pg_restore --list /tmp/backup.dump >/dev/null
docker exec "$CONTAINER" pg_restore --no-owner --no-privileges --username=ipsycho_restore --dbname=ipsycho_restore /tmp/backup.dump
TABLE_COUNT="$(docker exec "$CONTAINER" psql --tuples-only --no-align --username=ipsycho_restore --dbname=ipsycho_restore --command="select count(*) from pg_tables where schemaname='public'")"
[ "$TABLE_COUNT" -gt 0 ] || { echo "restore completed without public tables" >&2; exit 1; }

printf 'restore_check_ok file=%s tables=%s\n' "$INPUT" "$TABLE_COUNT"
