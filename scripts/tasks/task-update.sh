#!/usr/bin/env bash
# task-update.sh — Update a task in the task store.
# Usage: task-update.sh <id> [--title <t>] [--description <d>] [--priority <n>]
#                            [--status <s>] [--owner <o>] [--assignee <o>] [--external-ref <r>]
#
# Discord sync is handled in-process by the task sync watcher when the bot is
# running. To trigger a manual sync: task sync
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

TASK_IDS=()
for arg in "$@"; do
  [[ "$arg" =~ ^[a-z]+-[a-z0-9]+$ ]] && TASK_IDS+=("$arg")
done

if [[ ${#TASK_IDS[@]} -eq 0 ]]; then
  echo "Usage: task update <id> [flags]" >&2
  exit 1
fi

run_task_cli update "$@" || exit $?
