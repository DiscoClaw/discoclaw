# tasks.md — Task Tracking

Tasks are backed by an in-process `TaskStore` and synced to Discord forum threads.

## Data Model

Canonical type: `TaskData` in `src/tasks/types.ts`.

Statuses: `open` | `in_progress` | `blocked` | `closed`

## Task Store

Implementation: `src/tasks/store.ts`

- Synchronous in-memory writes
- Event emission on mutations (`created`, `updated`, `closed`, `labeled`)
- Optional JSONL persistence (`tasks.jsonl`)

## Discord Sync

Runtime sync implementation remains in `src/beads/*` modules for now, but is task-driven:

- `src/beads/bead-sync.ts`
- `src/beads/bead-sync-coordinator.ts`
- `src/beads/discord-sync.ts`
- `src/beads/bead-thread-cache.ts`
- `src/beads/forum-guard.ts`

Primary action trigger is `taskSync` via `src/discord/actions-tasks.ts`.

## Auto-Tagging

Auto-tagging runs through `src/beads/auto-tag.ts` and is controlled by the tasks env surface:

- `DISCOCLAW_TASKS_AUTO_TAG`
- `DISCOCLAW_TASKS_AUTO_TAG_MODEL`

## Config Surface

Primary names:

- `DISCOCLAW_TASKS_ENABLED`
- `DISCOCLAW_TASKS_FORUM`
- `DISCOCLAW_TASKS_CWD`
- `DISCOCLAW_TASKS_TAG_MAP`
- `DISCOCLAW_TASKS_MENTION_USER`
- `DISCOCLAW_TASKS_SIDEBAR`
- `DISCOCLAW_TASKS_AUTO_TAG`
- `DISCOCLAW_TASKS_AUTO_TAG_MODEL`
- `DISCOCLAW_TASKS_SYNC_SKIP_PHASE5`
- `DISCOCLAW_TASKS_PREFIX`
