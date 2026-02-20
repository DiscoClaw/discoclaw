#!/usr/bin/env bash
# bd-update.sh — Update a bead in the task store.
# Usage: bd-update.sh <id> [--title <t>] [--description <d>] [--priority <n>]
#                          [--status <s>] [--owner <o>] [--assignee <o>] [--external-ref <r>]
#
# Discord sync is handled in-process by BeadSyncWatcher when the bot is running.
# To trigger a manual sync: bd sync
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DISCOCLAW_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
CLI_DIST="$DISCOCLAW_DIR/dist/tasks/task-cli.js"
CLI_SRC="$DISCOCLAW_DIR/src/tasks/task-cli.ts"

run_task_cli() {
  if [[ -f "$CLI_DIST" ]]; then
    node "$CLI_DIST" "$@"
  else
    pnpm -C "$DISCOCLAW_DIR" tsx "$CLI_SRC" "$@"
  fi
}

BEAD_IDS=()
for arg in "$@"; do
  [[ "$arg" =~ ^[a-z]+-[a-z0-9]+$ ]] && BEAD_IDS+=("$arg")
done

if [[ ${#BEAD_IDS[@]} -eq 0 ]]; then
  echo "Usage: bd update <id> [flags]" >&2
  exit 1
fi

run_task_cli update "$@" || exit $?
