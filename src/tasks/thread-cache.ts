import type { TaskData } from './types.js';
import { getThreadIdFromTask } from './discord-sync.js';
import type { TaskStore } from './store.js';

// ---------------------------------------------------------------------------
// Thread → task lookup
// ---------------------------------------------------------------------------

/** Find a task by its Discord thread ID (matches via external_ref). */
export function findTaskByThreadId(threadId: string, store: TaskStore): TaskData | null {
  const tasks = store.list({ status: 'all' });
  return tasks.find((task) => getThreadIdFromTask(task) === threadId) ?? null;
}

// ---------------------------------------------------------------------------
// In-memory TTL cache: Discord thread ID → task data
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 120_000; // 2 minutes

type CacheEntry = {
  task: TaskData | null;
  fetchedAt: number;
};

export class TaskThreadCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Get task for a thread ID (cached or fresh). Returns null if no task matches. */
  async get(threadId: string, store: TaskStore): Promise<TaskData | null> {
    const entry = this.cache.get(threadId);
    if (entry && Date.now() - entry.fetchedAt < this.ttlMs) {
      return entry.task;
    }

    const tasks = store.list({ status: 'all' });
    const task = tasks.find((item) => getThreadIdFromTask(item) === threadId) ?? null;
    this.cache.set(threadId, { task, fetchedAt: Date.now() });
    return task;
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
export const taskThreadCache = new TaskThreadCache();

// ---------------------------------------------------------------------------
// Legacy compatibility aliases (remove in Phase 5 hard-cut).
// ---------------------------------------------------------------------------

export const findBeadByThreadId = findTaskByThreadId;
export { TaskThreadCache as BeadThreadCache };
export const beadThreadCache = taskThreadCache;
