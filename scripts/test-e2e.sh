#!/bin/sh
# Runs the PostgreSQL integration suite.
# With TEST_DATABASE_URL set (CI service container, a developer's own database) the script
# uses that database as is. Without it, a disposable Compose database is started and removed.
set -eu

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  e2e_compose='docker compose -p ipsycho_e2e -f docker-compose.e2e.yml'
  TEST_DATABASE_URL='postgres://ipsycho_e2e:ipsycho_e2e_only@127.0.0.1:5433/ipsycho_e2e'

  cleanup() {
    status=$?
    trap - EXIT INT TERM
    $e2e_compose down --volumes --remove-orphans || true
    exit "$status"
  }
  trap cleanup EXIT INT TERM

  $e2e_compose up --detach --wait
fi

DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
npm run build
# Every e2e file truncates the shared database, so files must not run concurrently.
TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test --test-concurrency=1 tests/e2e/*.test.mjs
