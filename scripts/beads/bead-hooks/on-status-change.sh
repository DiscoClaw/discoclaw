#!/usr/bin/env bash
# on-status-change.sh — Canonical status-change hook wrapper (delegates to TS implementation).
# Usage: on-status-change.sh <bead-id>
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DISCOCLAW_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

[[ $# -lt 1 ]] && { echo "Usage: on-status-change.sh <bead-id>" >&2; exit 1; }

CLI_DIST="$DISCOCLAW_DIR/dist/beads/bead-hooks-cli.js"
CLI_SRC="$DISCOCLAW_DIR/src/beads/bead-hooks-cli.ts"

if [[ -f "$CLI_DIST" ]]; then
  exec node "$CLI_DIST" on-status-change "$1"
else
  exec pnpm -C "$DISCOCLAW_DIR" tsx "$CLI_SRC" on-status-change "$1"
fi

