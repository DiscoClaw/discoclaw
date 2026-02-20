#!/usr/bin/env bash
# bead-close-sync.sh — PostToolUse hook: sync Discord thread when a bead is closed.
# Reads Claude Code hook JSON from stdin, fires on-close.sh for each closed bead.
# NOTE: bd CLI is deprecated. This hook supports the transition period only.
# The in-process task store emits close events directly; this hook is a no-op
# once all close paths go through the task store.
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
# Also match bare `bd close` (no trailing space) for zero-arg close.
[[ "$COMMAND" =~ ^[[:space:]]*bd[[:space:]]+close($|[[:space:]]) ]] || exit 0

# Try to extract bead IDs from the command args.
BEAD_IDS=()
SEEN_CLOSE=0
for word in $COMMAND; do
  [[ "$word" == "bd" ]] && continue
  [[ "$word" == "close" ]] && { SEEN_CLOSE=1; continue; }
  [[ $SEEN_CLOSE -eq 0 ]] && continue
  # Skip flags and their values (--reason "foo" etc).
  [[ "$word" == -* ]] && continue
  [[ "$word" =~ ^[a-z]+-[a-z0-9]+$ ]] && BEAD_IDS+=("$word")
done

# Fallback: if no IDs on command line (zero-arg close), parse stdout.
# bd outputs "✓ Closed <bead-id>: ..." for each closed bead.
if [[ ${#BEAD_IDS[@]} -eq 0 ]]; then
  STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // ""')
  while IFS= read -r line; do
    if [[ "$line" =~ Closed[[:space:]]+([a-z]+-[a-z0-9]+) ]]; then
      BEAD_IDS+=("${BASH_REMATCH[1]}")
    fi
  done <<< "$STDOUT"
fi

[[ ${#BEAD_IDS[@]} -eq 0 ]] && exit 0

# Verify hook script exists.
[[ -x "$HOOK_SCRIPT" ]] || exit 0

# For each bead, fire the hook.
# No bd CLI re-verification: the task store confirms close before emitting the event.
for bead_id in "${BEAD_IDS[@]}"; do
  "$HOOK_SCRIPT" "$bead_id" || echo "Warning: bead-close-sync: failed to sync $bead_id" >&2
done
