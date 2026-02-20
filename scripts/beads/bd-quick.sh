#!/bin/bash
# bd-quick.sh — Quick-capture a bead in the task store.
# Usage: bd-quick.sh "title" [--tags tag1,tag2]
#
# Outputs only the new bead ID. Discord sync is handled in-process by
# BeadSyncWatcher when the bot is running. To trigger a manual sync: bd sync
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

title_args=()
tags_arg=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tags) tags_arg="${2:-}"; shift 2 ;;
    *) title_args+=("$1"); shift ;;
  esac
done

bead_id=$(run_task_cli quick "${title_args[@]}" 2>&1)

if [[ ! "$bead_id" =~ ^[a-z]+-[a-z0-9]+$ ]]; then
  echo "$bead_id" >&2
  exit 1
fi

echo "$bead_id"

# Apply tags as labels (tag:<name>) so Discord sync can map them to forum tags.
if [[ -n "$tags_arg" ]]; then
  IFS=',' read -ra tag_list <<< "$tags_arg"
  for tag in "${tag_list[@]}"; do
    tag="${tag// /}"
    [[ -n "$tag" ]] && run_task_cli label-add "$bead_id" "tag:$tag" >/dev/null 2>&1 || true
  done
fi
