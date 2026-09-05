#!/usr/bin/env bash
# Runs on the VPS from the deploy workflow: checks out the verified commit, takes a pre-deploy
# dump, rebuilds, and only reports success once /ready answers with that commit. On any failure
# the previous commit is rebuilt again so the bot never stays down on a broken release.
set -euo pipefail

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
PROJECT_DIR="${PROJECT_DIR:-/opt/ipsycho}"
READY_ATTEMPTS="${READY_ATTEMPTS:-30}"
READY_INTERVAL_SECONDS="${READY_INTERVAL_SECONDS:-5}"
PRE_DEPLOY_DIR="$PROJECT_DIR/backups/pre-deploy"

cd "$PROJECT_DIR"
PREVIOUS_SHA="$(git rev-parse HEAD)"

# /ready on the new build, /health on anything older: a rollback target may predate /ready, and
# then the rollback would look like a failure even when the bot is back up.
ready_commit() {
  local body
  body="$(docker compose exec -T app wget -qO- http://127.0.0.1:3000/ready 2>/dev/null)"
  [ -n "$body" ] || body="$(docker compose exec -T app wget -qO- http://127.0.0.1:3000/health 2>/dev/null)"
  printf '%s' "$body" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p'
}

wait_ready() {
  local expected="$1" attempt=0 commit
  while [ "$attempt" -lt "$READY_ATTEMPTS" ]; do
    commit="$(ready_commit || true)"
    if [ "$commit" = "$expected" ]; then return 0; fi
    attempt=$((attempt + 1))
    sleep "$READY_INTERVAL_SECONDS"
  done
  return 1
}

bring_up() {
  APP_COMMIT="$1" docker compose up -d --build --remove-orphans --wait --wait-timeout 180
}

# A plain local dump before migrations run; the encrypted daily backup is the real archive.
# The tight umask stays inside this subshell: it must not reach the checkout below, where it would
# leave the source unreadable to the non-root user inside the image.
(
  umask 077
  mkdir -p "$PRE_DEPLOY_DIR"
  if docker compose ps --status running --services | grep -qx postgres; then
    docker compose exec -T postgres pg_dump --format=custom --no-owner --no-privileges --username=ipsycho --dbname=ipsycho > "$PRE_DEPLOY_DIR/$DEPLOY_SHA.dump"
    find "$PRE_DEPLOY_DIR" -maxdepth 1 -type f -name '*.dump' -exec ls -t {} + | awk 'NR>3' | xargs -r rm -f
  fi
)

git fetch --prune origin
git checkout --detach "$DEPLOY_SHA"

if bring_up "$DEPLOY_SHA" && wait_ready "$DEPLOY_SHA"; then
  printf 'deploy_ok commit=%s previous=%s\n' "$DEPLOY_SHA" "$PREVIOUS_SHA"
  exit 0
fi

echo "deploy of $DEPLOY_SHA did not become ready; rolling back to $PREVIOUS_SHA" >&2
docker compose logs --tail=100 app >&2 || true
git checkout --detach "$PREVIOUS_SHA"
bring_up "$PREVIOUS_SHA" || true
if wait_ready "$PREVIOUS_SHA"; then
  echo "rollback_ok commit=$PREVIOUS_SHA" >&2
else
  echo "rollback did not become ready either; manual intervention required" >&2
fi
exit 1
