#!/bin/sh
set -eu

e2e_compose='docker compose -p ipsycho_e2e -f docker-compose.e2e.yml'
e2e_url='postgres://ipsycho_e2e:ipsycho_e2e_only@127.0.0.1:5433/ipsycho_e2e'

cleanup() {
  $e2e_compose down --volumes --remove-orphans
}
trap cleanup EXIT INT TERM

$e2e_compose up --detach --wait
DATABASE_URL="$e2e_url" npm run migrate
npm run build
TEST_DATABASE_URL="$e2e_url" node --test tests/e2e/*.test.mjs
