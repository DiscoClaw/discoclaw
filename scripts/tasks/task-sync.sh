#!/usr/bin/env bash
# task-sync.sh — Canonical sync wrapper (delegates to task sync CLI).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISCOCLAW_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

CLI_DIST="$DISCOCLAW_DIR/dist/tasks/task-sync-cli.js"
CLI_SRC="$DISCOCLAW_DIR/src/tasks/task-sync-cli.ts"

if [[ -f "$CLI_DIST" ]]; then
  exec node "$CLI_DIST" "$@"
else
  exec pnpm -C "$DISCOCLAW_DIR" tsx "$CLI_SRC" "$@"
fi
