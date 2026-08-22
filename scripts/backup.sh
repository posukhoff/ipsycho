#!/usr/bin/env sh
set -eu

umask 077
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_KEY_FILE:?BACKUP_KEY_FILE is required}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
S3_BACKUP_URI="${S3_BACKUP_URI:-}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
DAY="$(date -u +%Y-%m-%d)"
WEEK="$(date -u +%G-W%V)"
DOW="$(date -u +%u)"
DAILY_DIR="$BACKUP_DIR/daily"
WEEKLY_DIR="$BACKUP_DIR/weekly"
RAW="$(mktemp "${TMPDIR:-/tmp}/ipsycho-backup.XXXXXX.dump")"
ENC="$DAILY_DIR/ipsycho-$STAMP.dump.enc"
trap 'rm -f "$RAW"' EXIT INT TERM

command -v pg_dump >/dev/null 2>&1 || { echo "pg_dump is required" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }
[ -r "$BACKUP_KEY_FILE" ] || { echo "BACKUP_KEY_FILE must be readable" >&2; exit 1; }
mkdir -p "$DAILY_DIR" "$WEEKLY_DIR"

pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$RAW"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$RAW" -out "$ENC"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$ENC" | pg_restore --list >/dev/null

# Keep the newest seven daily encrypted dumps.
find "$DAILY_DIR" -type f -name 'ipsycho-*.dump.enc' -printf '%T@ %p\n' 2>/dev/null \
  | sort -nr | awk 'NR>7 {sub(/^[^ ]+ /, ""); print}' | xargs -r rm -f

WEEKLY=""
if [ "$DOW" = "7" ]; then
  WEEKLY="$WEEKLY_DIR/ipsycho-$WEEK.dump.enc"
  cp "$ENC" "$WEEKLY"
  find "$WEEKLY_DIR" -type f -name 'ipsycho-*.dump.enc' -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr | awk 'NR>4 {sub(/^[^ ]+ /, ""); print}' | xargs -r rm -f
fi

if [ -n "$S3_BACKUP_URI" ]; then
  command -v aws >/dev/null 2>&1 || { echo "aws CLI is required when S3_BACKUP_URI is set" >&2; exit 1; }
  REMOTE_BASE="${S3_BACKUP_URI%/}"
  aws s3 cp "$ENC" "$REMOTE_BASE/daily/$(basename "$ENC")" --only-show-errors
  if [ -n "$WEEKLY" ]; then
    aws s3 cp "$WEEKLY" "$REMOTE_BASE/weekly/$(basename "$WEEKLY")" --only-show-errors
  fi
  aws s3 ls "$REMOTE_BASE/daily/" | awk '{print $4}' | grep '^ipsycho-.*\.dump\.enc$' | sort -r | awk 'NR>7' | while IFS= read -r name; do
    [ -n "$name" ] && aws s3 rm "$REMOTE_BASE/daily/$name" --only-show-errors
  done
  aws s3 ls "$REMOTE_BASE/weekly/" | awk '{print $4}' | grep '^ipsycho-.*\.dump\.enc$' | sort -r | awk 'NR>4' | while IFS= read -r name; do
    [ -n "$name" ] && aws s3 rm "$REMOTE_BASE/weekly/$name" --only-show-errors
  done
fi

printf 'backup_ok date=%s file=%s\n' "$DAY" "$ENC"
