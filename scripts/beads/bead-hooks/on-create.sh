#!/usr/bin/env bash
# on-create.sh — Canonical create hook wrapper (delegates to TS implementation).
# Usage: on-create.sh <bead-id> [--tags tag1,tag2]
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DISCOCLAW_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: on-create.sh <bead-id> [--tags tag1,tag2]" >&2
  exit 1
fi

bead_id="$1"; shift
tags_arg=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tags) tags_arg="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

# Preserve legacy behavior: if no tags explicitly provided, try local auto-tag helper.
if [[ -z "$tags_arg" && -x "$SCRIPT_DIR/auto-tag.sh" ]]; then
  title="$(bd show "$bead_id" --json 2>/dev/null | jq -r '.[0].title // empty' 2>/dev/null || true)"
  desc="$(bd show "$bead_id" --json 2>/dev/null | jq -r '.[0].description // empty' 2>/dev/null || true)"
  if [[ -n "$title" ]]; then
    tags_arg="$("$SCRIPT_DIR/auto-tag.sh" "$title" "$desc" 2>/dev/null || true)"
  fi
fi

CLI_DIST="$DISCOCLAW_DIR/dist/beads/bead-hooks-cli.js"
CLI_SRC="$DISCOCLAW_DIR/src/beads/bead-hooks-cli.ts"

if [[ -f "$CLI_DIST" ]]; then
  if [[ -n "$tags_arg" ]]; then
    exec node "$CLI_DIST" on-create "$bead_id" --tags "$tags_arg"
  fi
  exec node "$CLI_DIST" on-create "$bead_id"
else
  if [[ -n "$tags_arg" ]]; then
    exec pnpm -C "$DISCOCLAW_DIR" tsx "$CLI_SRC" on-create "$bead_id" --tags "$tags_arg"
  fi
  exec pnpm -C "$DISCOCLAW_DIR" tsx "$CLI_SRC" on-create "$bead_id"
fi

