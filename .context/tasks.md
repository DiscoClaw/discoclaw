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

## Data Directory

Task data lives in `data/tasks/`:

| File | Contents |
|------|----------|
| `tasks.jsonl` | One JSON object per line, one per task. Authoritative persistence for the in-memory `TaskStore`. |

Legacy path: `data/beads/tasks.jsonl`. Auto-migrated on first load if the canonical path doesn't exist yet.

`meta.json` format per task line:
```json
{"id":"ws-001","title":"...","status":"open","description":"...","priority":2,"labels":["tag:feature"],"created_at":"...","updated_at":"...","external_ref":"discord:..."}
```

## Exact Commands

```bash
# Count tasks by status
grep -c '"status":"open"' data/tasks/tasks.jsonl
grep -c '"status":"closed"' data/tasks/tasks.jsonl

# List all open task IDs and titles
grep '"status":"open"' data/tasks/tasks.jsonl | jq -r '[.id, .title] | @tsv'

# Find a specific task
grep 'ws-007' data/tasks/tasks.jsonl | jq .

# Check JSONL line count (should equal total tasks)
wc -l data/tasks/tasks.jsonl

# Check file permissions and size
ls -la data/tasks/tasks.jsonl

# Verify JSONL integrity (every line must parse)
while IFS= read -r line; do echo "$line" | jq empty 2>&1 || echo "CORRUPT: $line"; done < data/tasks/tasks.jsonl
```

## Known Footguns

- **Manual JSONL edits while the service is running:** The `TaskStore` holds tasks in memory and writes to `tasks.jsonl` asynchronously (fire-and-forget). If you edit `tasks.jsonl` by hand while the service is running, the next mutation overwrites your edit. Stop the service first, edit, then restart.
- **JSONL is append-only in concept, full-rewrite in practice:** Despite the `.jsonl` extension, `TaskStore.schedulePersist()` rewrites the entire file on every mutation. There is no append-only log. A crash mid-write can truncate the file.
- **`tasks.jsonl` is the only persistence layer:** There is no database backup. If the file is deleted or corrupted, in-memory state is lost on the next restart. The Discord forum threads survive but won't re-sync automatically into the store.
- **ID counter is derived from the highest ID in the file:** If `tasks.jsonl` is truncated or a task is removed, the counter may regress, potentially generating duplicate IDs. The prefix check (`ws-NNN`) prevents cross-prefix collisions but not within-prefix duplication if the highest-numbered task is lost.
- **Forum guard rejects manual threads:** Creating a thread manually in the tasks forum channel causes the bot to post a rejection message and archive the thread. Tasks must be created through bot commands (`taskCreate` action).
- **Sync is coalesced:** Rapid mutations trigger a single sync pass, not one per mutation. If the sync pass fails (e.g., rate-limited by Discord), some mutations may not reach Discord until the retry fires (default: 30s).
- **Deferred closes require a retry cycle:** When a task thread has an in-flight response, close operations are deferred. The thread won't archive until the retry timer fires after the response completes. This can leave "closed" tasks with open threads for up to 30 seconds.
- **`DISCOCLAW_TASKS_ENABLED` must be explicitly set to `0` to disable:** Any truthy value (including the string `"true"`) enables tasks. The default is enabled. Setting it to empty string or omitting it still enables the subsystem.
- **Missing forum ID logs a warning but doesn't crash:** If `DISCOCLAW_TASKS_FORUM` is unset and `DISCORD_GUILD_ID` doesn't resolve a forum, the task subsystem silently disables itself. No error in status — check logs for `tasks: no forum resolved`.

## Common Failure Modes

### Tasks not syncing to Discord forum
**Symptom:** Tasks are created via bot commands and appear in `tasks.jsonl`, but no forum threads appear or existing threads don't update (tags, title, archive state).
**Cause (in order of likelihood):**
1. `DISCOCLAW_TASKS_FORUM` is wrong or the forum channel was deleted.
2. The bot lacks `ManageThreads` or `SendMessages` permissions in the forum channel.
3. Startup sync failed silently (it's fire-and-forget).
4. Discord rate limits are blocking thread creation/updates.
**Recovery:**
```bash
# Check logs for sync errors
journalctl --user -u discoclaw.service --since "30 min ago" --no-pager | grep -i "task.*sync\|task.*fail\|task.*error"

# Verify the forum channel ID is valid
grep DISCOCLAW_TASKS_FORUM .env

# Check bot permissions — look for "Missing Permissions" or "Missing Access" in logs
journalctl --user -u discoclaw.service --since "1 hour ago" --no-pager | grep -i "missing\|permission\|forbidden"

# Force a sync by restarting (startup sync runs on boot)
systemctl --user restart discoclaw.service
journalctl --user -u discoclaw.service -f | grep -i "task"
```

### `tasks.jsonl` corrupted or truncated
**Symptom:** Bot starts but reports 0 tasks, or crashes with `SyntaxError: Unexpected end of JSON input` during load.
**Cause:** Crash or power loss during a `writeToDisk()` call. The file was partially written.
**Recovery:**
```bash
# Check the file for parse errors
while IFS= read -r line; do echo "$line" | jq empty 2>&1 || echo "BAD LINE: $line"; done < data/tasks/tasks.jsonl

# If only the last line is corrupt, remove it
head -n -1 data/tasks/tasks.jsonl > data/tasks/tasks.jsonl.fixed
mv data/tasks/tasks.jsonl data/tasks/tasks.jsonl.bak
mv data/tasks/tasks.jsonl.fixed data/tasks/tasks.jsonl

# If the file is empty or fully corrupt, check for legacy backup
ls -la data/beads/tasks.jsonl 2>/dev/null

# Last resort: delete the file and let the Discord forum be the source of truth
# Tasks won't auto-import from Discord — you'll need to recreate them via bot commands
rm data/tasks/tasks.jsonl
systemctl --user restart discoclaw.service
```

### Task store out of sync with Discord threads
**Symptom:** Task shows as "open" in `tasks.jsonl` but the Discord thread is archived/closed, or vice versa.
**Cause:** A sync failure left the two states divergent. Sync is one-directional (store → Discord), so Discord manual edits are not pulled back.
**Recovery:**
```bash
# Inspect the task in the store
grep '<task-id>' data/tasks/tasks.jsonl | jq .

# The store is authoritative. Restart to trigger a startup sync
# which will re-apply store state to Discord threads
systemctl --user restart discoclaw.service

# If the Discord thread state is correct and the store is wrong,
# update the task via bot command (e.g., "close task <id>")
```

### Duplicate task IDs after JSONL recovery
**Symptom:** After restoring from a backup `tasks.jsonl`, new tasks get IDs that collide with existing ones. Error: no visible crash, but task data gets overwritten in the store.
**Cause:** The ID counter is derived from the highest `ws-NNN` in the file. If the restored file has a lower max ID than what was previously created, the counter starts below the actual max.
**Recovery:**
```bash
# Find the highest ID currently in the file
grep -oP '"id":"ws-\K\d+' data/tasks/tasks.jsonl | sort -n | tail -1

# If you know tasks with higher IDs existed, manually add a placeholder
# line with a high ID to bump the counter, then restart
echo '{"id":"ws-999","title":"counter-bump","status":"closed","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}' >> data/tasks/tasks.jsonl
systemctl --user restart discoclaw.service
```

### Auto-tagging failing silently
**Symptom:** New tasks are created but don't get auto-tags applied to their Discord threads.
**Cause:** The auto-tag model call failed (rate limit, model unavailable), or `DISCOCLAW_TASKS_AUTO_TAG` is disabled.
**Recovery:**
```bash
# Check if auto-tagging is enabled
grep DISCOCLAW_TASKS_AUTO_TAG .env

# Check for auto-tag errors in logs
journalctl --user -u discoclaw.service --since "1 hour ago" --no-pager | grep -i "auto.tag\|label"

# Verify the tag map file exists and is valid JSON
cat data/tasks/tag-map.json 2>/dev/null || echo "No tag map file"
```
