#!/usr/bin/env sh
set -eu

# Production backup runner for the Docker Compose deployment. The PostgreSQL
# port stays private: pg_dump and pg_restore run inside the database container.
umask 077
: "${BACKUP_KEY_FILE:?BACKUP_KEY_FILE is required}"
: "${S3_BACKUP_URI:?S3_BACKUP_URI is required}"

PROJECT_DIR="${PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
S3_ENDPOINT_URL="${S3_ENDPOINT_URL:-}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
WEEK="$(date -u +%G-W%V)"
DOW="$(date -u +%u)"
DAILY_DIR="$BACKUP_DIR/daily"
WEEKLY_DIR="$BACKUP_DIR/weekly"
RAW="$(mktemp "${TMPDIR:-/tmp}/ipsycho-backup.XXXXXX.dump")"
ENC="$DAILY_DIR/ipsycho-$STAMP.dump.enc"
ENC_TMP="$(mktemp "${TMPDIR:-/tmp}/ipsycho-backup.XXXXXX.enc")"
cleanup() { rm -f "$RAW" "$ENC_TMP"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

aws_s3() {
  if [ -n "$S3_ENDPOINT_URL" ]; then
    aws --endpoint-url="$S3_ENDPOINT_URL" s3 "$@"
  else
    aws s3 "$@"
  fi
}

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }
[ -r "$BACKUP_KEY_FILE" ] || { echo "BACKUP_KEY_FILE must be readable" >&2; exit 1; }
case "$S3_BACKUP_URI" in s3://*) ;; *) echo "S3_BACKUP_URI must start with s3://" >&2; exit 1 ;; esac
mkdir -p "$DAILY_DIR" "$WEEKLY_DIR"

cd "$PROJECT_DIR"
docker compose ps --status running --services | grep -qx postgres || { echo "postgres Compose service is not running" >&2; exit 1; }
docker compose exec -T postgres pg_dump --format=custom --no-owner --no-privileges --username=ipsycho --dbname=ipsycho > "$RAW"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$RAW" -out "$ENC_TMP"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$ENC_TMP" | docker compose exec -T postgres pg_restore --list >/dev/null
mv "$ENC_TMP" "$ENC"

prune_local() {
  directory="$1" pattern="$2" keep="$3"
  find "$directory" -maxdepth 1 -type f -name "$pattern" -exec basename {} \; \
    | sort -r | awk -v keep="$keep" 'NR>keep' \
    | while IFS= read -r name; do [ -n "$name" ] && rm -f "$directory/$name"; done
}

# Keep the newest seven local daily copies and four local weekly copies.
prune_local "$DAILY_DIR" 'ipsycho-*.dump.enc' 7
if [ "$DOW" = "7" ]; then
  WEEKLY="$WEEKLY_DIR/ipsycho-$WEEK.dump.enc"
  cp "$ENC" "$WEEKLY"
  prune_local "$WEEKLY_DIR" 'ipsycho-*.dump.enc' 4
fi

REMOTE_BASE="${S3_BACKUP_URI%/}"
aws_s3 cp "$ENC" "$REMOTE_BASE/daily/$(basename "$ENC")" --only-show-errors
if [ "${WEEKLY:-}" != "" ]; then
  aws_s3 cp "$WEEKLY" "$REMOTE_BASE/weekly/$(basename "$WEEKLY")" --only-show-errors
fi
aws_s3 ls "$REMOTE_BASE/daily/" | awk '{print $4}' | grep '^ipsycho-.*\.dump\.enc$' | sort -r | awk 'NR>7' | while IFS= read -r name; do
  [ -n "$name" ] && aws_s3 rm "$REMOTE_BASE/daily/$name" --only-show-errors
done
aws_s3 ls "$REMOTE_BASE/weekly/" | awk '{print $4}' | grep '^ipsycho-.*\.dump\.enc$' | sort -r | awk 'NR>4' | while IFS= read -r name; do
  [ -n "$name" ] && aws_s3 rm "$REMOTE_BASE/weekly/$name" --only-show-errors
done

printf 'backup_ok file=%s\n' "$ENC"
