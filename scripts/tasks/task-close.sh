#!/usr/bin/env bash
# task-close.sh — Close tasks in the task store.
# Usage: task-close.sh <id> [<id>...] [--reason <reason>]
#
# Discord thread archiving is handled in-process by the task sync watcher when
# the bot is running. To trigger a manual sync: task sync
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
reason_args=()

# Split positional task IDs from --reason flag.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reason|-r) reason_args+=(--reason "${2:-}"); shift 2 ;;
    -*)          shift ;;
    *)
      [[ "$1" =~ ^[a-z]+-[a-z0-9]+$ ]] && TASK_IDS+=("$1")
      shift
      ;;
  esac
done

if [[ ${#TASK_IDS[@]} -eq 0 ]]; then
  echo "Usage: task close <id> [<id>...] [--reason <reason>]" >&2
  exit 1
fi

echo "Closing task(s)..."
for task_id in "${TASK_IDS[@]}"; do
  run_task_cli close "$task_id" "${reason_args[@]}" || {
    echo "Warning: Failed to close $task_id" >&2
  }
done
echo "Done!"
