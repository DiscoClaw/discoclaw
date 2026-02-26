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
  lastRunStatus: 'success' | 'error' | 'running' | 'interrupted' | null;
  startedAt?: string;
  lastErrorMessage?: string;
  cadence: CadenceTag | null;
  purposeTags: string[];
  disabled: boolean;
  model: string | null;
  modelOverride?: string;
  triggerType?: 'schedule' | 'webhook' | 'manual';  // defaults to 'schedule'
  webhookSourceId?: string;   // URL path segment for /webhook/:source routing
  webhookSecret?: string;     // HMAC-SHA256 secret for signature verification
  silent?: boolean;           // suppress output when AI has nothing actionable to report
  // Persisted cron definition fields — stored on parse so boots can skip AI re-parsing.
  schedule?: string;
  timezone?: string;
  channel?: string;
  prompt?: string;
  authorId?: string;
};

export type CronRunStatsStore = {
  version: 1 | 2 | 3 | 4 | 5 | 6;
  updatedAt: number;
  jobs: Record<string, CronRunRecord>;
};

export const CURRENT_VERSION = 6 as const;

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
  return { version: CURRENT_VERSION, updatedAt: Date.now(), jobs: {} };
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
  // Secondary index: statusMessageId → cronId for O(1) recovery lookups.
  private statusMessageIndex = new Map<string, string>();
  // Secondary index: webhookSourceId → cronId for O(1) webhook routing.
  private sourceIndex = new Map<string, string>();

  constructor(store: CronRunStatsStore, filePath: string) {
    this.store = store;
    this.filePath = filePath;
    this.rebuildThreadIndex();
  }

  private rebuildThreadIndex(): void {
    this.threadIndex.clear();
    this.statusMessageIndex.clear();
    this.sourceIndex.clear();
    for (const rec of Object.values(this.store.jobs)) {
      this.threadIndex.set(rec.threadId, rec.cronId);
      if (rec.statusMessageId) {
        this.statusMessageIndex.set(rec.statusMessageId, rec.cronId);
      }
      if (rec.webhookSourceId) {
        this.sourceIndex.set(rec.webhookSourceId, rec.cronId);
      }
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

  getRecordByStatusMessageId(statusMessageId: string): CronRunRecord | undefined {
    const cronId = this.statusMessageIndex.get(statusMessageId);
    return cronId ? this.store.jobs[cronId] : undefined;
  }

  getRecordBySourceId(sourceId: string): CronRunRecord | undefined {
    const cronId = this.sourceIndex.get(sourceId);
    return cronId ? this.store.jobs[cronId] : undefined;
  }

  async upsertRecord(cronId: string, threadId: string, updates?: Partial<CronRunRecord>): Promise<CronRunRecord> {
    let record: CronRunRecord;
    await this.mutex.run(async () => {
      // Enforce sourceId uniqueness before mutating state.
      const incomingSourceId = updates?.webhookSourceId;
      if (incomingSourceId !== undefined) {
        const claimant = this.sourceIndex.get(incomingSourceId);
        if (claimant && claimant !== cronId) {
          throw new Error(`webhookSourceId "${incomingSourceId}" is already claimed by cronId "${claimant}"`);
        }
      }

      const existing = this.store.jobs[cronId];
      if (existing) {
        const prevStatusMessageId = existing.statusMessageId;
        const prevSourceId = existing.webhookSourceId;
        // If threadId changed, remove old index entry.
        if (existing.threadId !== threadId) {
          this.threadIndex.delete(existing.threadId);
        }
        if (updates) Object.assign(existing, updates);
        existing.threadId = threadId;
        if (prevStatusMessageId && prevStatusMessageId !== existing.statusMessageId) {
          this.statusMessageIndex.delete(prevStatusMessageId);
        }
        if (prevSourceId && prevSourceId !== existing.webhookSourceId) {
          this.sourceIndex.delete(prevSourceId);
        }
        record = existing;
      } else {
        record = { ...emptyRecord(cronId, threadId), ...updates };
        this.store.jobs[cronId] = record;
      }
      this.threadIndex.set(threadId, cronId);
      if (record.statusMessageId) {
        this.statusMessageIndex.set(record.statusMessageId, cronId);
      }
      if (record.webhookSourceId) {
        this.sourceIndex.set(record.webhookSourceId, cronId);
      }
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

  async recordRunStart(cronId: string): Promise<void> {
    await this.mutex.run(async () => {
      const rec = this.store.jobs[cronId];
      if (!rec) return;
      rec.lastRunStatus = 'running';
      rec.startedAt = new Date().toISOString();
      this.store.updatedAt = Date.now();
      await this.flush();
    });
  }

  async sweepInterrupted(): Promise<string[]> {
    const affected: string[] = [];
    await this.mutex.run(async () => {
      for (const rec of Object.values(this.store.jobs)) {
        if (rec.lastRunStatus === 'running') {
          rec.lastRunStatus = 'interrupted';
          affected.push(rec.cronId);
        }
      }
      if (affected.length > 0) {
        this.store.updatedAt = Date.now();
        await this.flush();
      }
    });
    return affected;
  }

  async removeRecord(cronId: string): Promise<boolean> {
    let removed = false;
    await this.mutex.run(async () => {
      const rec = this.store.jobs[cronId];
      if (rec) {
        this.threadIndex.delete(rec.threadId);
        if (rec.statusMessageId) this.statusMessageIndex.delete(rec.statusMessageId);
        if (rec.webhookSourceId) this.sourceIndex.delete(rec.webhookSourceId);
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
          if (rec.statusMessageId) this.statusMessageIndex.delete(rec.statusMessageId);
          if (rec.webhookSourceId) this.sourceIndex.delete(rec.webhookSourceId);
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
    const parsedObj = parsed as { version?: unknown; jobs?: unknown };
    if (
      parsed &&
      typeof parsed === 'object' &&
      'version' in parsedObj &&
      'jobs' in parsedObj &&
      typeof parsedObj.jobs === 'object' &&
      parsedObj.jobs !== null
    ) {
      store = parsed as CronRunStatsStore;
    } else {
      store = emptyStore();
    }
  } catch {
    store = emptyStore();
  }
  // Sequential version-migration guards — see docs/data-migration.md for the convention.
  // Each block handles exactly one step; transformations are additive only.
  // Migrate v1 → v2: backfill triggerType on existing records (additive, no data loss).
  if (store.version === 1) {
    for (const rec of Object.values(store.jobs)) {
      if (!rec.triggerType) rec.triggerType = 'schedule';
    }
    store.version = 2;
  }
  // Migrate v2 → v3: ensure triggerType is set on any records that lack it
  // (records created via upsertRecord without an explicit triggerType update).
  if (store.version === 2) {
    for (const rec of Object.values(store.jobs)) {
      if (!rec.triggerType) rec.triggerType = 'schedule';
    }
    store.version = 3;
  }
  // Migrate v3 → v4: no-op — new fields (startedAt, running/interrupted statuses) are optional/additive.
  if (store.version === 3) {
    store.version = 4;
  }
  // Migrate v4 → v5: no-op — new field (silent) is optional and defaults falsy.
  if (store.version === 4) {
    store.version = 5;
  }
  // Migrate v5 → v6: no-op — new persisted definition fields (schedule, timezone, channel, prompt, authorId) are optional.
  // Absent records fall through to AI parsing on first boot after upgrade.
  if (store.version === 5) {
    store.version = 6;
  }
  return new CronRunStats(store, filePath);
}
