#!/usr/bin/env bash
# task-quick.sh — Quick-capture a task in the task store.
# Usage: task-quick.sh "title" [--tags tag1,tag2]
#
# Outputs only the new task ID. Discord sync is handled in-process by the task
# sync watcher when the bot is running. To trigger a manual sync: task sync
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

task_id=$(run_task_cli quick "${title_args[@]}" 2>&1)

if [[ ! "$task_id" =~ ^[a-z]+-[a-z0-9]+$ ]]; then
  echo "$task_id" >&2
  exit 1
fi

echo "$task_id"

# Apply tags as labels (tag:<name>) so Discord sync can map them to forum tags.
if [[ -n "$tags_arg" ]]; then
  IFS=',' read -ra tag_list <<< "$tags_arg"
  for tag in "${tag_list[@]}"; do
    tag="${tag// /}"
    [[ -n "$tag" ]] && run_task_cli label-add "$task_id" "tag:$tag" >/dev/null 2>&1 || true
  done
fi
