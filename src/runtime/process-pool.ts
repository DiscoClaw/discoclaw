import { LongRunningProcess, type LongRunningProcessOpts } from './long-running-process.js';

export type ProcessPoolOpts = {
  maxProcesses?: number;
  log?: { info(...args: unknown[]): void; debug(...args: unknown[]): void };
};

/**
 * Pool of LongRunningProcess instances keyed by Discord session key.
 */
export class ProcessPool {
  private readonly pool = new Map<string, LongRunningProcess>();
  private readonly maxProcesses: number;
  private readonly log?: ProcessPoolOpts['log'];

  constructor(opts?: ProcessPoolOpts) {
    this.maxProcesses = opts?.maxProcesses ?? 5;
    this.log = opts?.log;
  }

  /**
   * Get an existing alive process for the session key, or spawn a new one.
   * Returns null if spawn fails (caller should fall back to one-shot).
   */
  getOrSpawn(sessionKey: string, processOpts: LongRunningProcessOpts): LongRunningProcess | null {
    const existing = this.pool.get(sessionKey);
    if (existing?.state === 'idle') {
      this.log?.debug({ sessionKey }, 'process-pool: reusing existing process');
      // True LRU: touch on access (Map preserves insertion order).
      this.pool.delete(sessionKey);
      this.pool.set(sessionKey, existing);
      return existing;
    }

    // Remove dead process if present.
    if (existing) {
      // If the process is busy, do not disrupt it: fall back to one-shot.
      if (existing.state === 'busy') {
        this.log?.debug({ sessionKey }, 'process-pool: session busy, falling back to one-shot');
        return null;
      }
      this.pool.delete(sessionKey);
    }

    // Evict least-recently-used idle process if at capacity. If none are idle, do not evict.
    if (this.pool.size >= this.maxProcesses) {
      const evicted = this.evictOldestIdle();
      if (!evicted) {
        this.log?.debug({ sessionKey, poolSize: this.pool.size }, 'process-pool: at capacity with no idle processes');
        return null;
      }
    }

    // Spawn a new process.
    const proc = new LongRunningProcess(processOpts);
    const ok = proc.spawn();
    if (!ok) {
      this.log?.info({ sessionKey }, 'process-pool: spawn failed');
      return null;
    }

    // Auto-remove when the process dies.
    proc.onCleanup = () => {
      const current = this.pool.get(sessionKey);
      if (current === proc) {
        this.pool.delete(sessionKey);
      }
    };

    this.pool.set(sessionKey, proc);
    this.log?.info({ sessionKey, poolSize: this.pool.size }, 'process-pool: spawned new process');
    return proc;
  }

  /** Kill and remove a specific session's process. */
  remove(sessionKey: string, reason?: string): void {
    const proc = this.pool.get(sessionKey);
    if (proc) {
      this.pool.delete(sessionKey);
      proc.kill();
      this.log?.info({ sessionKey, reason }, 'process-pool: removed process');
    }
  }

  /** Kill all processes (shutdown cleanup). */
  killAll(): void {
    for (const [key, proc] of this.pool) {
      proc.forceKill();
      this.log?.debug({ sessionKey: key }, 'process-pool: killed process');
    }
    this.pool.clear();
  }

  get size(): number {
    return this.pool.size;
  }

  private evictOldestIdle(): boolean {
    // Map iteration order is LRU (oldest to newest) because we "touch" on reuse.
    for (const [key, proc] of this.pool) {
      if (proc.state === 'idle') {
        this.pool.delete(key);
        proc.kill();
        this.log?.info({ sessionKey: key }, 'process-pool: evicted idle process');
        return true;
      }
    }
    return false;
  }
}
