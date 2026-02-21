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

Canonical runtime sync implementation lives in `src/tasks/*`:

- `src/tasks/task-sync-engine.ts`
- `src/tasks/sync-coordinator.ts`
- `src/tasks/discord-sync.ts`
- `src/tasks/thread-cache.ts`
- `src/tasks/forum-guard.ts`

Legacy runtime compatibility shims under `src/beads/` have been removed.

Primary action trigger is `taskSync` via `src/discord/actions-tasks.ts`.

## Auto-Tagging

Auto-tagging runs through `src/tasks/auto-tag.ts` and is controlled by the tasks env surface:

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
