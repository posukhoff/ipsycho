#!/usr/bin/env bash
# Runs from cron on the VPS every few minutes. When /ready stops answering it tells the owner in
# Telegram, once per outage, and again when the app comes back. It is not a dead-man switch: if the
# machine itself dies this script dies with it. It covers the common case — the app crash-looping
# or the database refusing connections while the box is up.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
STATE_FILE="${WATCHDOG_STATE:-$PROJECT_DIR/backups/.watchdog.state}"
FAILURES_BEFORE_ALERT="${FAILURES_BEFORE_ALERT:-2}"
cd "$PROJECT_DIR"

# Telegram carries the token in the URL, and a URL on a command line is visible to every user
# through `ps`. curl reads the whole request from stdin instead, so the token never becomes argv.
notify() {
  local text="$1" token owner escaped
  token="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' .env | head -1)"
  owner="$(sed -n 's/^OWNER_TELEGRAM_USER_ID=//p' .env | head -1)"
  [ -n "$token" ] && [ -n "$owner" ] || { echo "watchdog: no bot token or owner id in .env" >&2; return 1; }
  escaped="${text//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\ndata-urlencode = "text=%s"\n' "$token" "$owner" "$escaped" |
    curl -fsS -m 15 --retry 2 --config - >/dev/null
}

state="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
case "$state" in ''|*[!0-9]*) state=0 ;; esac

if docker compose exec -T app wget -qO- http://127.0.0.1:3000/ready 2>/dev/null | grep -q '"status":"ok"'; then
  if [ "$state" -ge "$FAILURES_BEFORE_ALERT" ]; then
    notify "IPsycho снова отвечает: /ready ok на $(hostname)." || true
  fi
  echo 0 > "$STATE_FILE"
  exit 0
fi

state=$((state + 1))
echo "$state" > "$STATE_FILE"
printf 'watchdog: /ready did not answer (%s consecutive)\n' "$state" >&2
# One message per outage: the state file already counts, so only the crossing point alerts.
if [ "$state" -eq "$FAILURES_BEFORE_ALERT" ]; then
  notify "IPsycho не отвечает: /ready молчит $state проверки подряд на $(hostname). Контейнеры: $(docker compose ps --format '{{.Service}}={{.State}}' | tr '\n' ' ')" || true
fi
exit 1
