# beads.md — Beads Task Tracking

Beads = lightweight issue tracker backed by the `bd` CLI, synced bidirectionally to Discord forum threads.
Two paths (CLI from terminal, bot via Discord actions) produce identical Discord state.
See `discord.md` §Beads for the Discord integration side.

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

## CLI (`bd`)

Wrapper: `src/beads/bd-cli.ts`. Binary: `BD_BIN` (default `bd`), CWD: `DISCOCLAW_BEADS_CWD`.

```bash
bd show  --json <id>
bd list  --json [--all | --status <s>] [--label <l>] [--limit <n>]
bd create --json <title> [--description <d>] [--priority <n>] [--type <t>] [--assignee <o>] [--labels <l1,l2>]
bd update <id> [--title <t>] [--description <d>] [--priority <n>] [--status <s>] [--assignee <o>] [--external-ref <ref>]
bd close  <id> [--reason <r>]
bd label add <id> <label>
```

JSON output is parsed via `parseBdJson<T>()` which strips markdown fences and handles error objects.

## Discord Sync (4-Phase)

Full sync runs on startup, on file-watcher trigger, and via `beadSync` action. All paths go through `BeadSyncCoordinator` to prevent concurrent runs.

| Phase | Action |
|-------|--------|
| 1. Create missing | Open beads without `external_ref` (and without `no-thread` label) get forum threads. Dedupes against existing threads before creating. |
| 2. Fix mismatches | Open beads with `waiting-*` or `blocked-*` labels get status set to `blocked`. |
| 3. Sync names/starters | Active beads: unarchive if needed, update thread name (`{emoji} [{shortId}] {title}`), update starter message with metadata. |
| 4. Archive closed | Closed beads: post close summary, rename thread, archive. |

Throttled at 250ms between API calls. Auto-triggered syncs are silent; only explicit `beadSync` posts to the status channel.

## Hooks

Shell scripts in `scripts/beads/bead-hooks/` delegate to `bead-hooks-cli.ts`:

| Script | Trigger | Action |
|--------|---------|--------|
| `on-create.sh` | bead created | Create thread, set `external_ref`, backfill tag labels |
| `on-update.sh` | bead updated | Unarchive, update thread name, post update message |
| `on-status-change.sh` | status changed | Unarchive, update thread name emoji |
| `on-close.sh` | bead closed | Post close summary, rename, archive thread |
| `auto-tag.sh` | called by on-create | AI classify title+desc into 1-3 tags via `fast` tier |

**`lib.sh`** — shared utils: `get_bead_json`, `build_thread_name`, `ensure_unarchived`, `truncate_message`.

**Claude Code hook** (`.claude/hooks/bead-close-sync.sh`): PostToolUse hook that detects `bd close` in Bash and fires `on-close.sh` immediately, faster than the 2s file-watcher debounce. Setup requires `.claude/settings.local.json` entry (see `dev.md` §Bead Close Sync).

## Auto-Tagging

`src/beads/auto-tag.ts` — on create, sends title + first 500 chars of description to the `fast` tier (configurable via `DISCOCLAW_BEADS_AUTO_TAG_MODEL`). Returns 1-3 tags matched case-insensitively against `tag-map.json`. Silently returns `[]` on failure. Controlled by `DISCOCLAW_BEADS_AUTO_TAG`.

## Config Reference

See `dev.md` §Beads for the full env var table. Key vars:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DISCOCLAW_BEADS_ENABLED` | `1` | Master switch |
| `BD_BIN` | `bd` | Path to bd binary |
| `DISCOCLAW_BEADS_CWD` | `WORKSPACE_CWD` | bd working directory |
| `DISCOCLAW_BEADS_FORUM` | **(required when enabled)** | Forum channel ID (snowflake) for threads |
| `DISCOCLAW_BEADS_AUTO_TAG` | `1` | AI tagging on create |
| `DISCOCLAW_BEADS_TAG_MAP` | `scripts/beads/bead-hooks/tag-map.json` | Tag-to-forum-tag ID map |

## Implementation

| Component | Location |
|-----------|----------|
| Types & status emoji | `src/beads/types.ts` |
| BD CLI wrapper | `src/beads/bd-cli.ts` |
| Hook entry point | `src/beads/bead-hooks-cli.ts` |
| Discord thread ops | `src/beads/discord-sync.ts` |
| 4-phase sync | `src/beads/bead-sync.ts` |
| Auto-tag | `src/beads/auto-tag.ts` |
| Thread cache | `src/beads/bead-thread-cache.ts` |
| File watcher | `src/beads/bead-sync-watcher.ts` |
| Sync coordinator | `src/beads/bead-sync-coordinator.ts` |
| Forum guard | `src/beads/forum-guard.ts` |
| Shell hooks | `scripts/beads/bead-hooks/` |
| Wrapper scripts | `scripts/beads/bd-wrapper.sh`, `bd-new.sh`, `bd-close-archive.sh` |
| Claude Code hook | `.claude/hooks/bead-close-sync.sh` |
| Discord actions | `src/discord/actions-beads.ts` |
