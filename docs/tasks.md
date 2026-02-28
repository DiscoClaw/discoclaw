# DiscoClaw Task System

The task system provides lightweight work tracking with bidirectional sync between an in-process task store and Discord forum threads. Tasks can be created from either side — ask the bot in chat, use task commands, or let automations create them.

## Task Lifecycle

Tasks follow a simple status progression:

```
create → in_progress → done/closed
```

| Status | Thread state | Emoji |
|--------|-------------|-------|
| `open` | Active thread | Varies by priority |
| `in_progress` | Active thread | Work-in-progress indicator |
| `done` | Archived thread | Completed indicator |
| `closed` | Archived thread | Closed indicator |

Each task gets a unique ID with a configurable prefix (default `ws`, e.g., `ws-42`).

## Live Task Awareness

Open tasks are injected into every prompt at invocation time, sourced directly from the TaskStore. This means every new session starts with accurate task state regardless of rolling-summary freshness — the AI always knows which tasks are currently open without relying on stale summary text.

The injection is controlled by `DISCOCLAW_OPEN_TASKS_INJECT_ENABLED` (default `true`) with a character budget of `DISCOCLAW_OPEN_TASKS_INJECT_MAX_CHARS` (default `1000`).

## Bidirectional Sync

The sync engine keeps the task store and Discord forum threads in sync. Changes on either side are detected and propagated:

- **Task created in store** → forum thread is created
- **Task status updated** → thread name/emoji updated, archived if closed
- **Thread archived in Discord** → task status updated to closed
- **Thread tags changed** → task tags updated

### The 5-Phase Sync Pipeline

The sync engine runs a 5-phase pipeline to ensure consistency:

**Phase 1 — Create threads.** Tasks with no `external_ref` (no linked forum thread) get a new thread created in the tasks forum.

**Phase 2 — Fix label mismatches.** Corrects cases where thread labels don't match task status (e.g., a "blocked" label on an open task).

**Phase 3 — Sync emoji/names/content.** Updates thread names (emoji prefix, title), starter message content, and tags to match the current task state.

**Phase 4 — Archive closed tasks.** Archives forum threads for tasks that are done or closed.

**Phase 5 — Reconcile.** Scans forum threads against the task store. Archives stale threads for closed tasks and detects orphan threads with no matching task.

### Skipping Phase 5

Phase 5 (reconcile) scans all forum threads, which can be slow on servers with many threads. If sync is taking too long or causing rate-limit issues, you can skip it:

```
DISCOCLAW_TASKS_SYNC_SKIP_PHASE5=true
```

Phase 5 is a safety net — skipping it means orphan threads won't be detected until the next full sync. Phases 1–4 handle the common cases.

## Manual Sync

The sync pipeline runs automatically on task mutations. To force a full sync manually:

```
!task sync
```

Or use the `taskSync` Discord action.

## Tag Map

Forum tags on task threads are managed via a tag map file (`DISCOCLAW_TASKS_TAG_MAP`). This JSON file maps tag names to Discord forum tag IDs. Example:

```json
{
  "bug": "1234567890",
  "feature": "1234567891",
  "docs": "1234567892"
}
```

When auto-tagging is enabled (`DISCOCLAW_TASKS_AUTO_TAG=true`), the AI classifies each task and applies matching tags from the tag map.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_TASKS_ENABLED` | `true` | Enable the task subsystem |
| `DISCOCLAW_TASKS_FORUM` | — | Forum channel ID (auto-created if not set) |
| `DISCOCLAW_TASKS_CWD` | — | Override task working directory |
| `DISCOCLAW_TASKS_TAG_MAP` | — | Path to tag map JSON file |
| `DISCOCLAW_TASKS_MENTION_USER` | — | User ID to @mention on task creation |
| `DISCOCLAW_TASKS_SIDEBAR` | `true` | Show tasks in forum sidebar |
| `DISCOCLAW_TASKS_AUTO_TAG` | `true` | Auto-tag task threads via AI |
| `DISCOCLAW_TASKS_AUTO_TAG_MODEL` | `fast` | Model tier for auto-tagging |
| `DISCOCLAW_TASKS_SYNC_SKIP_PHASE5` | `false` | Skip the reconcile phase |
| `DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_ENABLED` | `true` | Retry failed sync operations |
| `DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_DELAY_MS` | `30000` | Delay before retrying failed sync |
| `DISCOCLAW_TASKS_SYNC_DEFERRED_RETRY_DELAY_MS` | `30000` | Delay before retrying deferred sync |
| `DISCOCLAW_TASKS_PREFIX` | `ws` | Prefix for task IDs |
