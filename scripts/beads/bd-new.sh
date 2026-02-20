#!/bin/bash
# bd-new.sh — Create a bead in the task store and queue its Discord thread.
# Usage: bd-new.sh <title> [--description <d>] [--priority <n>] [--type <t>]
#                          [--owner <o>] [--labels <l1,l2>] [--tags tag1,tag2]
#
# Discord sync is handled in-process by BeadSyncWatcher when the bot is running.
# To trigger a manual sync: bd sync  (or: scripts/beads/bead-thread-sync.sh)
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DISCOCLAW_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
CLI_DIST="$DISCOCLAW_DIR/dist/tasks/task-cli.js"
CLI_SRC="$DISCOCLAW_DIR/src/tasks/task-cli.ts"
GUILD_ID="${DISCORD_GUILD_ID:-}"

run_task_cli() {
  if [[ -f "$CLI_DIST" ]]; then
    node "$CLI_DIST" "$@"
  else
    pnpm -C "$DISCOCLAW_DIR" tsx "$CLI_SRC" "$@"
  fi
}

# Extract --tags from args (pass everything else to task-cli create).
cli_args=()
tags_arg=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tags) tags_arg="${2:-}"; shift 2 ;;
    *) cli_args+=("$1"); shift ;;
  esac
done

output=$(run_task_cli create "${cli_args[@]}" 2>&1)
bead_id=$(echo "$output" | jq -r ".id // empty" 2>/dev/null | head -1)

if [[ -z "$bead_id" ]]; then
  echo "Failed to create bead or parse bead ID" >&2
  echo "$output" >&2
  exit 1
fi

title=$(echo "$output" | jq -r '.title // "Untitled"')

# Apply tags as labels (tag:<name>) so Discord sync can map them to forum tags.
if [[ -n "$tags_arg" ]]; then
  IFS=',' read -ra tag_list <<< "$tags_arg"
  for tag in "${tag_list[@]}"; do
    tag="${tag// /}"
    [[ -n "$tag" ]] && run_task_cli label-add "$bead_id" "tag:$tag" >/dev/null 2>&1 || true
  done
fi

thread_ref=$(run_task_cli get "$bead_id" 2>/dev/null | jq -r '.[0].external_ref // empty')
if [[ "$thread_ref" =~ ^discord:([0-9]+)$ && -n "$GUILD_ID" ]]; then
  thread_id="${BASH_REMATCH[1]}"
  echo "Created bead $bead_id with Discord thread"
  echo "  Title: $title"
  [[ -n "$tags_arg" ]] && echo "  Tags: $tags_arg"
  echo "  Thread: https://discord.com/channels/$GUILD_ID/$thread_id"
else
  echo "Created bead $bead_id (Discord sync pending — run: bd sync)"
  echo "  Title: $title"
  [[ -n "$tags_arg" ]] && echo "  Tags: $tags_arg"
fi
