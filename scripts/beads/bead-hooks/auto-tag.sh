#!/usr/bin/env bash
# auto-tag.sh — DEPRECATED: auto-tagging is now handled in-process.
#
# On bead create, src/beads/auto-tag.ts classifies the title + first 500 chars
# of the description using the configured 'fast' model tier (controlled by
# DISCOCLAW_TASKS_AUTO_TAG_MODEL). Tags are matched case-insensitively against
# scripts/beads/bead-hooks/tag-map.json (or DISCOCLAW_TASKS_TAG_MAP).
#
# Controlled by: DISCOCLAW_TASKS_AUTO_TAG=1 (default on)
#
# This script is retained as documentation only. It is no longer invoked.
set -euo pipefail

log() { echo "$*" >&2; }

log "auto-tag: auto-tagging is handled in-process via src/beads/auto-tag.ts"
log "          Set DISCOCLAW_TASKS_AUTO_TAG=0 to disable."
exit 0
