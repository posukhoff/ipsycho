#!/usr/bin/env bash
# Local development: the compiler and the app watch together; Ctrl-C stops both.
set -euo pipefail
trap 'kill 0' EXIT INT TERM
npx tsc -p tsconfig.json --watch --preserveWatchOutput &
sleep 3
node --watch dist/main.js &
wait
