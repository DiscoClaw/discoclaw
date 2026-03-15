#!/usr/bin/env bash
# task-wrapper.sh — Route task-store commands through canonical helper scripts.
# Install: alias task="$DISCOCLAW_DIR/scripts/tasks/task-wrapper.sh"
#
# All reads/writes go through the in-process TaskStore (src/tasks/task-cli.ts).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ $# -eq 0 ]]; then
  echo "Usage: task <subcommand> [args]"
  echo "Subcommands: create, new, q, quick, close, update, sync, list, show, get"
  exit 0
fi

subcommand="$1"
shift

case "$subcommand" in
  create|new)  exec "$SCRIPT_DIR/task-new.sh" "$@" ;;
  q|quick)     exec "$SCRIPT_DIR/task-quick.sh" "$@" ;;
  close)       exec "$SCRIPT_DIR/task-close.sh" "$@" ;;
  update)      exec "$SCRIPT_DIR/task-update.sh" "$@" ;;
  sync)        exec "$SCRIPT_DIR/task-sync.sh" "$@" ;;
  list|show|get)
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
    echo "Supported: create, new, q, quick, close, update, sync, list, show, get" >&2
    exit 1
    ;;
esac
