#!/usr/bin/env bash
# bd-close-archive.sh — Close beads in the task store.
# Usage: bd-close-archive.sh <id> [<id>...] [--reason <reason>]
#
# Discord thread archiving is handled in-process by BeadSyncWatcher when the
# bot is running. To trigger a manual sync: bd sync
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
reason_args=()

# Split positional bead IDs from --reason flag.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reason|-r) reason_args+=(--reason "${2:-}"); shift 2 ;;
    -*)          shift ;;  # ignore unknown flags
    *)
      [[ "$1" =~ ^[a-z]+-[a-z0-9]+$ ]] && BEAD_IDS+=("$1")
      shift
      ;;
  esac
done

if [[ ${#BEAD_IDS[@]} -eq 0 ]]; then
  echo "Usage: bd close <id> [<id>...] [--reason <reason>]" >&2
  exit 1
fi

echo "Closing bead(s)..."
for bead_id in "${BEAD_IDS[@]}"; do
  run_task_cli close "$bead_id" "${reason_args[@]}" || {
    echo "Warning: Failed to close $bead_id" >&2
  }
done
echo "Done!"
