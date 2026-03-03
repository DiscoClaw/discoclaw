// In-memory registry tracking in-flight spawned agents.
// Parallels the abort-registry (which owns abort signals) but tracks
// spawn-specific metadata so the shutdown handler can report how many
// agents were in flight when the process exited.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpawnEntry = {
  key: string;
  label: string;
  startedAt: Date;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const active = new Map<string, SpawnEntry>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register an in-flight spawn. Returns a dispose function that removes
 * the entry when the spawn completes (success, error, or abort).
 */
export function registerSpawn(key: string, label: string): { dispose: () => void } {
  const entry: SpawnEntry = { key, label, startedAt: new Date() };
  active.set(key, entry);
  return {
    dispose() {
      active.delete(key);
    },
  };
}

/** Number of spawns currently in flight. */
export function activeCount(): number {
  return active.size;
}

/** Snapshot of all in-flight spawns. */
export function listActive(): SpawnEntry[] {
  return [...active.values()];
}

/**
 * Clear all tracked spawns and return how many were in flight.
 * Called during graceful shutdown so the count can be written to
 * shutdown-context.json for startup reporting.
 *
 * Note: this does NOT abort the spawns — the abort-registry handles
 * signal propagation. This only clears the metadata.
 */
export function cancelAll(): number {
  const count = active.size;
  active.clear();
  return count;
}

/** Clear all state. Only for use in tests. */
export function _resetForTest(): void {
  active.clear();
}
