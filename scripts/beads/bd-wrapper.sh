#!/usr/bin/env bash
# bd-wrapper.sh — Route task-store commands through hook-aware scripts.
# Install: alias bd="$DISCOCLAW_DIR/scripts/beads/bd-wrapper.sh"
#
# All reads/writes go through the in-process TaskStore (src/tasks/task-cli.ts).
# The external `bd` CLI is no longer required.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ $# -eq 0 ]]; then
  echo "Usage: bd <subcommand> [args]"
  echo "Subcommands: create, new, q, close, update, sync, list, show"
  exit 0
fi

subcommand="$1"
shift

case "$subcommand" in
  create|new)  exec "$SCRIPT_DIR/bd-new.sh" "$@" ;;
  q)           exec "$SCRIPT_DIR/bd-quick.sh" "$@" ;;
  close)       exec "$SCRIPT_DIR/bd-close-archive.sh" "$@" ;;
  update)      exec "$SCRIPT_DIR/bd-update.sh" "$@" ;;
  sync)        exec "$SCRIPT_DIR/bead-thread-sync.sh" "$@" ;;
  list|show)
    DISCOCLAW_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
    CLI_DIST="$DISCOCLAW_DIR/dist/tasks/task-cli.js"
    CLI_SRC="$DISCOCLAW_DIR/src/tasks/task-cli.ts"
    if [[ -f "$CLI_DIST" ]]; then
      exec node "$CLI_DIST" "$subcommand" "$@"
    else
      exec pnpm -C "$DISCOCLAW_DIR" tsx "$CLI_SRC" "$subcommand" "$@"
    fi
    ;;
  *)
    echo "Unknown subcommand: $subcommand" >&2
    echo "Supported: create, new, q, close, update, sync, list, show" >&2
    exit 1
    ;;
esac
