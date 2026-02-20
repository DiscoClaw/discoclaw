#!/usr/bin/env bash
# on-create.sh — DEPRECATED: create events are now handled in-process.
#
# The in-process TaskStore emits a 'created' event synchronously on every
# store.create() call. BeadSyncWatcher subscribes to that event and triggers
# a full Discord sync automatically. No external hook script is invoked.
#
# To trigger a manual sync from the CLI, run:
#   pnpm tsx src/beads/bead-sync-cli.ts
set -euo pipefail

log() { echo "$*" >&2; }

log "on-create: events are handled in-process via TaskStore (src/beads/bead-sync-watcher.ts)"
log "          No bd CLI or external hook is required."
exit 0
