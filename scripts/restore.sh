#!/usr/bin/env sh
set -eu

umask 077
: "${1:?usage: scripts/restore.sh <encrypted-backup>}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
: "${BACKUP_KEY_FILE:?BACKUP_KEY_FILE is required}"

INPUT="$1"
[ -r "$INPUT" ] || { echo "backup file is not readable: $INPUT" >&2; exit 1; }
[ -r "$BACKUP_KEY_FILE" ] || { echo "BACKUP_KEY_FILE must be readable" >&2; exit 1; }
command -v pg_restore >/dev/null 2>&1 || { echo "pg_restore is required" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

if [ "${DATABASE_URL:-}" = "$RESTORE_DATABASE_URL" ] && [ "${ALLOW_RESTORE_TO_PRIMARY:-0}" != "1" ]; then
  echo "refusing to restore into DATABASE_URL; use a disposable database or set ALLOW_RESTORE_TO_PRIMARY=1 explicitly" >&2
  exit 1
fi

RAW="$(mktemp "${TMPDIR:-/tmp}/ipsycho-restore.XXXXXX.dump")"
trap 'rm -f "$RAW"' EXIT INT TERM
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$INPUT" -out "$RAW"
pg_restore --list "$RAW" >/dev/null
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL" "$RAW"
printf 'restore_ok file=%s\n' "$INPUT"
