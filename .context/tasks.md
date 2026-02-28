# tasks.md — Task Tracking

Tasks are backed by an in-process `TaskStore` and synced to Discord forum threads.

Ground-zero post-hard-cut refactor tracker: `docs/tasks-ground-zero-post-hard-cut-plan.md`
Ground-zero task architecture refactor status: COMPLETE (FROZEN), verified on 2026-02-21.

## Prompt Injection

Open task statuses are injected into prompts at invocation time, sourced directly
from the TaskStore. This ensures every new session starts with accurate task state
regardless of rolling summary freshness. See `.context/memory.md` for assembly order
and token budget.

## Data Model

Canonical type: `TaskData` in `src/tasks/types.ts`.

Statuses: `open` | `in_progress` | `blocked` | `closed`

## Task Store

Implementation: `src/tasks/store.ts`

Architecture contract: `src/tasks/architecture-contract.ts`
Mutation entrypoint service: `src/tasks/service.ts`

- Synchronous in-memory writes
- Event emission on mutations (`created`, `updated`, `closed`, `labeled`)
- Optional JSONL persistence (`tasks.jsonl`)

## Discord Sync

Canonical runtime sync implementation lives in `src/tasks/*`:

- `src/tasks/task-sync-engine.ts`
- `src/tasks/task-sync-pipeline.ts`
- `src/tasks/task-sync-apply-plan.ts`
- `src/tasks/task-sync-reconcile-plan.ts`
- `src/tasks/task-sync-apply-types.ts`
- `src/tasks/task-sync-phase-apply.ts`
- `src/tasks/task-sync-reconcile.ts`
- `src/tasks/sync-coordinator.ts`
- `src/tasks/sync-coordinator-metrics.ts`
- `src/tasks/sync-coordinator-retries.ts`
- `src/tasks/thread-helpers.ts`
- `src/tasks/thread-forum-ops.ts`
- `src/tasks/thread-lifecycle-ops.ts`
- `src/tasks/thread-ops.ts` (facade)
- `src/tasks/tag-map.ts`
- `src/tasks/thread-cache.ts`
- `src/tasks/forum-guard.ts`

Primary action trigger is `taskSync` via `src/tasks/task-action-executor.ts`.

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
- `DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_ENABLED`
- `DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_DELAY_MS`
- `DISCOCLAW_TASKS_SYNC_DEFERRED_RETRY_DELAY_MS`
