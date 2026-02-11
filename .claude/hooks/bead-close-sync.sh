#!/usr/bin/env bash
# bead-close-sync.sh — PostToolUse hook: sync Discord thread when `bd close` succeeds.
# Reads Claude Code hook JSON from stdin, fires on-close.sh for each closed bead.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DISCOCLAW_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOK_SCRIPT="$DISCOCLAW_DIR/scripts/beads/bead-hooks/on-close.sh"

# Read hook JSON from stdin.
INPUT=$(cat)

# Gate: only fire on successful commands.
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // 1')
[[ "$EXIT_CODE" != "0" ]] && exit 0

# Extract the command.
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
[[ -z "$COMMAND" ]] && exit 0

# Only match direct `bd close ...` commands (not inside scripts/pipes/subshells).
[[ "$COMMAND" =~ ^[[:space:]]*bd[[:space:]]+close[[:space:]] ]] || exit 0

# Extract bead IDs (same pattern as bd-close-archive.sh).
BEAD_IDS=()
for word in $COMMAND; do
  [[ "$word" == "bd" || "$word" == "close" || "$word" == -* ]] && continue
  [[ "$word" =~ ^[a-z]+-[a-z0-9]+$ ]] && BEAD_IDS+=("$word")
done

[[ ${#BEAD_IDS[@]} -eq 0 ]] && exit 0

# Verify hook script exists.
[[ -x "$HOOK_SCRIPT" ]] || exit 0

# For each bead, verify it's actually closed, then fire the hook.
for bead_id in "${BEAD_IDS[@]}"; do
  # Belt-and-suspenders: confirm bead is closed before syncing.
  STATUS=$(bd show --json "$bead_id" 2>/dev/null | jq -r '.status // ""' || true)
  [[ "$STATUS" != "closed" ]] && continue

  "$HOOK_SCRIPT" "$bead_id" || echo "Warning: bead-close-sync: failed to sync $bead_id" >&2
done
