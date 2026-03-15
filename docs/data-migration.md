# Data Migration Convention

Every persistent store in DiscoClaw uses an **inline version-migration** pattern:
load the raw JSON, migrate in-process to the current version, then continue.
No separate migration CLI. No migration history table.

## Version Field Requirements

- Every store envelope **must** have an integer `version` field.
- The TypeScript type enumerates all known versions, e.g.:
  ```ts
  type MyStore = { version: 1 | 2 | 3; updatedAt: number; jobs: Record<string, Job> };
  ```
- `emptyStore()` (or equivalent) always returns the **current** (highest) version.
- When the loader encounters an unknown or missing version it creates a fresh store
  rather than crashing.

## Migration Function Pattern

`src/cron/run-stats.ts` is the canonical exemplar. Its `loadRunStats()` function:

1. Reads and parses the JSON file.
2. Guards for missing/malformed envelopes and falls back to `emptyStore()`.
3. Applies sequential version guards, one step at a time:

```ts
// Migrate v1 → v2: backfill triggerType on existing records.
if (store.version === 1) {
  for (const rec of Object.values(store.jobs)) {
    if (!rec.triggerType) rec.triggerType = 'schedule';
  }
  store.version = 2;
}
// Migrate v2 → v3: ensure no records slipped through without triggerType.
if (store.version === 2) {
  for (const rec of Object.values(store.jobs)) {
    if (!rec.triggerType) rec.triggerType = 'schedule';
  }
  store.version = 3;
}
```

**Rules:**

- Each block handles exactly one version step. Never skip versions.
- Transformations are **additive only** — backfill new fields; never delete existing data.
- After all guards execute, `store.version` equals the current version.
- The migrated store is not flushed automatically; the next normal write persists it.

## JSONL Stores

For append-only `.jsonl` files (one JSON object per line):

- Maintain a `schemaVersion` field in every line object (not a top-level envelope).
- On load, apply the same sequential guard logic to each parsed line object.
- If any lines were upgraded, rewrite the file atomically (tmp + rename) before use.
- Do not mix versioned and unversioned lines in the same file.

## Bare-Array Backward-Compat Envelope

If an older store serialized a bare JSON array with no version field, detect it on load
and wrap it in an envelope before entering the normal migration chain:

```ts
if (Array.isArray(parsed)) {
  store = { version: 1, updatedAt: Date.now(), items: parsed };
}
```

Add this guard **once** when introducing the versioned envelope. Once all instances in
the wild have been upgraded through a normal write cycle, the guard can be removed.
