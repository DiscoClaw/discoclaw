#!/usr/bin/env bash
# on-close.sh — Canonical close hook wrapper (delegates to TS implementation).
# Usage: on-close.sh <bead-id>
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DISCOCLAW_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

[[ $# -lt 1 ]] && { echo "Usage: on-close.sh <bead-id>" >&2; exit 1; }

CLI_DIST="$DISCOCLAW_DIR/dist/beads/bead-hooks-cli.js"
CLI_SRC="$DISCOCLAW_DIR/src/beads/bead-hooks-cli.ts"

if [[ -f "$CLI_DIST" ]]; then
  exec node "$CLI_DIST" on-close "$1"
else
  exec pnpm -C "$DISCOCLAW_DIR" tsx "$CLI_SRC" on-close "$1"
fi

