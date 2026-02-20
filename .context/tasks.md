# tasks.md — Task Tracking

Tasks = lightweight issue tracker backed by an **in-process task store**, synced bidirectionally to Discord forum threads.
Two paths (CLI from terminal, bot via Discord actions) produce identical Discord state.
See `discord.md` §Tasks for the Discord integration side.

## Data Model

**`BeadData`** (`src/beads/types.ts`):

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | e.g. `ws-001` |
| `title` | `string` | |
| `status` | `BeadStatus` | see below |
| `description?` | `string` | |
| `priority?` | `number` | default 2; displayed as `P{n}` |
| `issue_type?` | `string` | |
| `owner?` | `string` | |
| `external_ref?` | `string` | `discord:<threadId>` or raw numeric ID |
| `labels?` | `string[]` | e.g. `["no-thread", "tag:feature"]` |
| `comments?` | `Array<{author, body, created_at}>` | |
| `created_at?` | `string` | |
| `updated_at?` | `string` | |
| `closed_at?` | `string` | |
| `close_reason?` | `string` | |

**Statuses:** `open` | `in_progress` | `blocked` | `closed`

**Status emoji:** open=🟢 in_progress=🟡 blocked=⚠️ closed=☑️

## Task Store

In-process store: `src/beads/task-store.ts`. Data dir: `DISCOCLAW_BEADS_DATA_DIR` (default `<WORKSPACE_CWD>/.beads`).

```ts
taskStore.create(data)          // create task → emits 'create' event synchronously
taskStore.update(id, patch)     // update fields → emits 'update' event synchronously
taskStore.close(id, reason?)    // close task → emits 'close' event synchronously
taskStore.get(id)               // fetch single task
taskStore.list(opts)            // list with optional status/label/limit filters
taskStore.addLabel(id, label)   // add label → emits 'update' event synchronously
```

All writes are synchronous events — no subprocess spawning, no file watcher, no debounce.

## Discord Sync (4-Phase)

Full sync runs on startup and via `beadSync` action. All paths go through `BeadSyncCoordinator` to prevent concurrent runs.

| Phase | Action |
|-------|--------|
| 1. Create missing | Open tasks without `external_ref` (and without `no-thread` label) get forum threads. Dedupes against existing threads before creating. |
| 2. Fix mismatches | Open tasks with `waiting-*` or `blocked-*` labels get status set to `blocked`. |
| 3. Sync names/starters | Active tasks: unarchive if needed, update thread name (`{emoji} [{shortId}] {title}`), update starter message with metadata. |
| 4. Archive closed | Closed tasks: post close summary, rename thread, archive. |

Throttled at 250ms between API calls. Auto-triggered syncs are silent; only explicit `beadSync` posts to the status channel.

## Events

Task store emits synchronous events on every write. Discord sync hooks subscribe directly — no shell scripts, no subprocesses.

| Event | Trigger | Discord Action |
|-------|---------|----------------|
| `create` | task created | Create thread, set `external_ref`, backfill tag labels |
| `update` | task updated | Unarchive, update thread name, post update message |
| `status-change` | status changed | Unarchive, update thread name emoji |
| `close` | task closed | Post close summary, rename, archive thread |

Auto-tagging on `create`: AI classifies title+desc into 1-3 tags, then fires an `update` to apply them.

## Auto-Tagging

`src/beads/auto-tag.ts` — on create, sends title + first 500 chars of description to the `fast` tier (configurable via `DISCOCLAW_BEADS_AUTO_TAG_MODEL`). Returns 1-3 tags matched case-insensitively against `tag-map.json`. Silently returns `[]` on failure. Controlled by `DISCOCLAW_BEADS_AUTO_TAG`.

## Config Reference

See `dev.md` §Tasks for the full env var table. Key vars:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DISCOCLAW_BEADS_ENABLED` | `1` | Master switch |
| `DISCOCLAW_BEADS_DATA_DIR` | `<WORKSPACE_CWD>/.beads` | Task store data directory |
| `DISCOCLAW_BEADS_FORUM` | **(required when enabled)** | Forum channel ID (snowflake) for threads |
| `DISCOCLAW_BEADS_AUTO_TAG` | `1` | AI tagging on create |
| `DISCOCLAW_BEADS_TAG_MAP` | `scripts/beads/tag-map.json` | Tag-to-forum-tag ID map |

## Implementation

| Component | Location |
|-----------|----------|
| Types & status emoji | `src/beads/types.ts` |
| In-process task store | `src/beads/task-store.ts` |
| Discord thread ops | `src/beads/discord-sync.ts` |
| 4-phase sync | `src/beads/bead-sync.ts` |
| Auto-tag | `src/beads/auto-tag.ts` |
| Thread cache | `src/beads/bead-thread-cache.ts` |
| Sync coordinator | `src/beads/bead-sync-coordinator.ts` |
| Forum guard | `src/beads/forum-guard.ts` |
| Tag map | `scripts/beads/tag-map.json` |
| Discord actions | `src/discord/actions-beads.ts` |
