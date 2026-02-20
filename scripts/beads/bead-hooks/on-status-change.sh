#!/usr/bin/env bash
# on-status-change.sh — DEPRECATED: status-change events are now handled in-process.
#
# The in-process TaskStore emits an 'updated' event synchronously on every
# store.update() call (including status changes). TaskSyncWatcher subscribes
# to that event and triggers a full Discord sync automatically.
# No external hook script is invoked.
#
# To trigger a manual sync from the CLI, run:
#   pnpm tsx src/tasks/task-sync-cli.ts
set -euo pipefail

log() { echo "$*" >&2; }

log "on-status-change: events are handled in-process via TaskStore (src/tasks/sync-watcher.ts)"
log "                  No bd CLI or external hook is required."
exit 0
