import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const CADENCE_TAGS = ['yearly', 'frequent', 'hourly', 'daily', 'weekly', 'monthly'] as const;
export type CadenceTag = (typeof CADENCE_TAGS)[number];

export type CronRunRecord = {
  cronId: string;
  threadId: string;
  statusMessageId?: string;
  runCount: number;
  lastRunAt: string | null;
  lastRunStatus: 'success' | 'error' | null;
  lastErrorMessage?: string;
  cadence: CadenceTag | null;
  purposeTags: string[];
  disabled: boolean;
  model: 'haiku' | 'opus' | null;
  modelOverride?: 'haiku' | 'opus';
};

export type CronRunStatsStore = {
  version: 1;
  updatedAt: number;
  jobs: Record<string, CronRunRecord>;
};

// ---------------------------------------------------------------------------
// Stable Cron ID generation
// ---------------------------------------------------------------------------

export function generateCronId(): string {
  return `cron-${crypto.randomBytes(4).toString('hex')}`;
}

export function parseCronIdFromContent(content: string): string | null {
  const match = content.match(/\[cronId:(cron-[a-f0-9]+)\]/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Async mutex (simple serialized write queue without p-limit dependency)
// ---------------------------------------------------------------------------

type QueueEntry = { fn: () => Promise<void>; resolve: () => void; reject: (err: unknown) => void };

class WriteMutex {
  private queue: QueueEntry[] = [];
  private running = false;

  async run(fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      if (!this.running) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      try {
        await entry.fn();
        entry.resolve();
      } catch (err) {
        entry.reject(err);
      }
    }
    this.running = false;
  }
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export function emptyStore(): CronRunStatsStore {
  return { version: 1, updatedAt: Date.now(), jobs: {} };
}

function emptyRecord(cronId: string, threadId: string): CronRunRecord {
  return {
    cronId,
    threadId,
    runCount: 0,
    lastRunAt: null,
    lastRunStatus: null,
    cadence: null,
    purposeTags: [],
    disabled: false,
    model: null,
  };
}

export class CronRunStats {
  private store: CronRunStatsStore;
  private filePath: string;
  private mutex = new WriteMutex();
  // Secondary index: threadId → cronId for O(1) lookups.
  private threadIndex = new Map<string, string>();

  constructor(store: CronRunStatsStore, filePath: string) {
    this.store = store;
    this.filePath = filePath;
    this.rebuildThreadIndex();
  }

  private rebuildThreadIndex(): void {
    this.threadIndex.clear();
    for (const rec of Object.values(this.store.jobs)) {
      this.threadIndex.set(rec.threadId, rec.cronId);
    }
  }

  getStore(): CronRunStatsStore {
    return this.store;
  }

  getRecord(cronId: string): CronRunRecord | undefined {
    return this.store.jobs[cronId];
  }

  getRecordByThreadId(threadId: string): CronRunRecord | undefined {
    const cronId = this.threadIndex.get(threadId);
    return cronId ? this.store.jobs[cronId] : undefined;
  }

  async upsertRecord(cronId: string, threadId: string, updates?: Partial<CronRunRecord>): Promise<CronRunRecord> {
    let record: CronRunRecord;
    await this.mutex.run(async () => {
      const existing = this.store.jobs[cronId];
      if (existing) {
        // If threadId changed, remove old index entry.
        if (existing.threadId !== threadId) {
          this.threadIndex.delete(existing.threadId);
        }
        if (updates) Object.assign(existing, updates);
        existing.threadId = threadId;
        record = existing;
      } else {
        record = { ...emptyRecord(cronId, threadId), ...updates };
        this.store.jobs[cronId] = record;
      }
      this.threadIndex.set(threadId, cronId);
      this.store.updatedAt = Date.now();
      await this.flush();
    });
    return record!;
  }

  async recordRun(cronId: string, status: 'success' | 'error', errorMessage?: string): Promise<void> {
    await this.mutex.run(async () => {
      const rec = this.store.jobs[cronId];
      if (!rec) return;
      rec.runCount++;
      rec.lastRunAt = new Date().toISOString();
      rec.lastRunStatus = status;
      if (status === 'error' && errorMessage) {
        rec.lastErrorMessage = errorMessage.slice(0, 200);
      } else {
        delete rec.lastErrorMessage;
      }
      this.store.updatedAt = Date.now();
      await this.flush();
    });
  }

  async removeRecord(cronId: string): Promise<boolean> {
    let removed = false;
    await this.mutex.run(async () => {
      const rec = this.store.jobs[cronId];
      if (rec) {
        this.threadIndex.delete(rec.threadId);
        delete this.store.jobs[cronId];
        this.store.updatedAt = Date.now();
        removed = true;
        await this.flush();
      }
    });
    return removed;
  }

  async removeByThreadId(threadId: string): Promise<boolean> {
    let removed = false;
    await this.mutex.run(async () => {
      for (const [cronId, rec] of Object.entries(this.store.jobs)) {
        if (rec.threadId === threadId) {
          this.threadIndex.delete(threadId);
          delete this.store.jobs[cronId];
          removed = true;
        }
      }
      if (removed) {
        this.store.updatedAt = Date.now();
        await this.flush();
      }
    });
    return removed;
  }

  private async flush(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(this.store, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

// ---------------------------------------------------------------------------
// Load / create
// ---------------------------------------------------------------------------

export async function loadRunStats(filePath: string): Promise<CronRunStats> {
  let store: CronRunStatsStore;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      'jobs' in parsed &&
      typeof (parsed as any).jobs === 'object'
    ) {
      store = parsed as CronRunStatsStore;
    } else {
      store = emptyStore();
    }
  } catch {
    store = emptyStore();
  }
  return new CronRunStats(store, filePath);
}
