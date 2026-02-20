# Tasks Migration — bd CLI to In-Process TaskStore

Documents the migration of the task read/write path from the external `bd` CLI to the
in-process `TaskStore` (plan-138).

---

## 1. Motivation

The `bd` CLI integration had several structural problems:

- **Race conditions** — the file watcher (`bead-sync-watcher.ts`) used `fs.watch` on the
  bd SQLite file and fired before bd had finished flushing its WAL, causing syncs to read
  stale data.
- **CLI string-matching brittleness** — JSON output from `bd` varied across versions;
  markdown-fenced output, error object shapes, and exit code semantics all required
  defensive parsing (`parseBdJson`, multiple `try/catch` layers).
- **No title search** — `bdFindByTitle()` fetched the full bead list over the wire and
  filtered client-side; there was no server-side title query.
- **Daemon routing confusion** — without explicit `--db` / `--no-daemon` flags, `bd`
  auto-walked up parent directories and connected to the wrong daemon in multi-workspace
  setups. Every call required pinning via the `--db <path>` flag.
- **External process overhead** — every `bdCreate`, `bdUpdate`, and `bdClose` spawned a
  subprocess. Latency scaled with the number of mutations in a sync cycle.
- **Impedance mismatch** — the `bd` data model diverged slightly from `TaskData` (legacy
  `done`/`tombstone` statuses, variable field presence). A normalization layer was required
  for every read.

---

## 2. What Changed

### New subsystem: `src/tasks/`

| Component | File | Description |
|-----------|------|-------------|
| Task types | `src/tasks/types.ts` | `TaskData`, `TaskCreateParams`, `TaskUpdateParams`, `TaskListParams`, `TaskStatus`, `STATUS_EMOJI` |
| In-process store | `src/tasks/store.ts` | `TaskStore` — EventEmitter-backed Map; synchronous in-memory writes; optional JSONL persistence |
| Migration helper | `src/tasks/migrate.ts` | `migrateFromBd()` one-shot bd → JSONL dump; `writeJsonl()` utility |

### Canonical runtime: `src/tasks/`

| File | Change |
|------|--------|
| `sync-watcher.ts` | Subscribes to `TaskStore` events (replacing `fs.watch` file-trigger model) |
| `sync-coordinator.ts` | Accepts `store: TaskStore`; reads tasks from the store, not from `bdList` |
| `task-sync-engine.ts` | Accepts `store: TaskStore`; sync reads go through `store.list()` / `store.get()` |
| `initialize.ts` | Creates or accepts a `TaskStore`; wires store events to sync coordinator |
| `discord-sync.ts` | Thread-to-task matching uses store lookups, not CLI calls |

### Compatibility layer: `src/beads/`

Legacy `src/beads/*` files remain as task-backed compatibility shims and aliases.
`src/beads/bd-cli.ts` is also retained for migration/preflight helper functions.

### Updated: `src/discord/`

`plan-commands.ts`, `actions-tasks.ts`, `actions-forge.ts`, `actions-plan.ts`,
`forge-commands.ts`, and `message-coordinator.ts` now accept and use a `TaskStore`
instance (`taskStore` / `store` field) instead of importing `bd-cli` functions.

---

## 3. TaskStore

`TaskStore` (`src/tasks/store.ts`) is an `EventEmitter<TaskStoreEventMap>`-backed
`Map<string, TaskData>`.

### Operations

| Method | Description |
|--------|-------------|
| `create(params)` | Creates a task, emits `"created"`, schedules persist |
| `update(id, params)` | Updates fields, emits `"updated"`, schedules persist |
| `close(id, reason?)` | Sets `status: "closed"`, emits `"closed"`, schedules persist |
| `addLabel(id, label)` | Adds a label, emits `"labeled"`, schedules persist |
| `removeLabel(id, label)` | Removes a label, emits `"updated"`, schedules persist |
| `get(id)` | Synchronous lookup by ID; returns `undefined` if not found |
| `list(params?)` | Filtered list; excludes closed by default |
| `findByTitle(title, opts?)` | Case-insensitive title match among non-closed tasks |
| `size()` | Total count (all statuses) |
| `load()` | Populate from the configured JSONL file (async; no-op if no `persistPath`) |
| `flush()` | Await the most recently scheduled persist |

### Events

| Event | Payload | When |
|-------|---------|------|
| `"created"` | `(task: TaskData)` | After `create()` |
| `"updated"` | `(task: TaskData, prev: TaskData)` | After `update()` or `removeLabel()` |
| `"closed"` | `(task: TaskData)` | After `close()` |
| `"labeled"` | `(task: TaskData, label: string)` | After `addLabel()` |

Events are **synchronous** — listeners fire before the mutating method returns. This is
what makes the event-driven sync model race-free: by the time `coordinator.sync()` is
called from a store event listener, the mutation is already reflected in `store.list()`.

### ID generation

IDs follow the pattern `<prefix>-NNN` (zero-padded to 3 digits). The prefix defaults to
`"t"` and is set by the caller:

```ts
new TaskStore({ prefix: 'ws' }) // generates ws-001, ws-002, …
```

The counter advances monotonically and is seeded from the highest numeric suffix seen
during `load()`, so restarting the process never re-uses an existing ID.

### Persistence

Configure `persistPath` to enable JSONL durability:

```ts
const store = new TaskStore({ persistPath: '/path/to/tasks.jsonl' });
await store.load(); // populate from existing file
```

Every mutation schedules a full-file rewrite as a fire-and-forget background write. The
in-memory store is always authoritative — a failed persist does not roll back in-memory
state. Call `await store.flush()` to wait for the latest write before a clean shutdown.

---

## 4. One-Shot Migration from bd

To seed a fresh `TaskStore` from an existing `bd` database:

```ts
import { migrateFromBd } from './src/tasks/migrate.js';
import { TaskStore } from './src/tasks/store.js';

// Step 1: dump all tasks from bd to JSONL
await migrateFromBd({
  cwd: process.cwd(),          // bd workspace root
  destPath: '/path/to/tasks.jsonl',
});

// Step 2: create a store that reads and persists to that file
const store = new TaskStore({ persistPath: '/path/to/tasks.jsonl' });
await store.load();
```

`migrateFromBd()` calls `bdList({ status: 'all', limit: 0 })` via the bd CLI and
writes the result as JSONL (one record per line). It is a one-shot operation — any
existing content at `destPath` is overwritten.

After migration, the `TaskStore` is the sole write path. The bd SQLite database is no
longer updated by DiscoClaw.

---

## 5. Event-Driven Sync (replacing the file watcher)

### Before (fs.watch)

```
bd write → SQLite WAL flush (async) → fs.watch fires → debounce(300ms) → sync
```

The race window between the WAL flush and the `fs.watch` event meant the sync sometimes
ran against data that hadn't landed yet. The debounce was a band-aid.

### After (store events)

```
store.create/update/close/addLabel → event emitted synchronously
  → startTaskSyncWatcher listener → coordinator.sync()
  → TaskSyncCoordinator coalesces concurrent calls → one sync run
```

There is no debounce. The store event fires after the in-memory write is committed.
`TaskSyncCoordinator`'s internal `syncing` flag coalesces any concurrent trigger into a
follow-up run, so at most two full syncs can be in flight for any burst of mutations.

### Watcher API

```ts
import { startTaskSyncWatcher } from './src/tasks/sync-watcher.js';

const handle = startTaskSyncWatcher({ coordinator, store, log });
// later…
handle.stop(); // unsubscribes all listeners
```

`wireTaskSync()` in `initialize.ts` manages this subscription automatically as part of
the standard tasks boot sequence.

---

## 6. bd-cli.ts Retained Functions

`src/beads/bd-cli.ts` is kept for functions still needed outside the live task path:

| Function | Why retained |
|----------|-------------|
| `buildBeadContextSummary(beadId, store)` | Builds the bead context block injected into AI prompts; now uses `TaskStore` directly |
| `checkBdAvailable()` | Used by `pnpm preflight` / setup wizard to verify the bd CLI is installed |
| `ensureBdDatabaseReady(cwd)` | Used by `pnpm preflight` to check the db prefix is configured |
| `normalizeBeadData(bead)` | Normalizes legacy `done`/`tombstone` statuses; used by `migrateFromBd` |
| `parseBdJson<T>(stdout)` | JSON parser for bd CLI output; used by `migrateFromBd` and bd-cli tests |

The raw `runBd()` helper and `bdCreate`, `bdUpdate`, `bdClose`, `bdAddLabel` functions
remain in the file but are no longer called by any production path. They are candidates
for removal once the migration tooling is no longer needed.
