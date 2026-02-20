import type { BeadData } from './types.js';
import { getThreadIdFromBead } from './discord-sync.js';
import type { TaskStore } from '../tasks/store.js';

// ---------------------------------------------------------------------------
// Thread → bead lookup
// ---------------------------------------------------------------------------

/** Find a bead by its Discord thread ID (matches via external_ref). */
export function findBeadByThreadId(threadId: string, store: TaskStore): BeadData | null {
  const beads = store.list({ status: 'all' });
  return beads.find((b) => getThreadIdFromBead(b) === threadId) ?? null;
}

// ---------------------------------------------------------------------------
// In-memory TTL cache: Discord thread ID → bead data
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 120_000; // 2 minutes

type CacheEntry = {
  bead: BeadData | null;
  fetchedAt: number;
};

export class BeadThreadCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Get bead for a thread ID (cached or fresh). Returns null if no bead matches. */
  async get(threadId: string, store: TaskStore): Promise<BeadData | null> {
    const entry = this.cache.get(threadId);
    if (entry && Date.now() - entry.fetchedAt < this.ttlMs) {
      return entry.bead;
    }

    const beads = store.list({ status: 'all' });
    const bead = beads.find((b) => getThreadIdFromBead(b) === threadId) ?? null;
    this.cache.set(threadId, { bead, fetchedAt: Date.now() });
    return bead;
  }

  /** Invalidate one entry or all entries. */
  invalidate(threadId?: string): void {
    if (threadId) {
      this.cache.delete(threadId);
    } else {
      this.cache.clear();
    }
  }
}

/** Module-level singleton used by the bot process. */
export const beadThreadCache = new BeadThreadCache();
