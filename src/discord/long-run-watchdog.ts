import fs from 'node:fs/promises';
import path from 'node:path';
import type { LoggerLike } from '../logging/logger-like.js';

type RunStatus = 'running' | 'completed';
type CompletionKind = 'succeeded' | 'failed' | 'interrupted';

type PersistedStore = {
  version: 1;
  runs: Record<string, LongRunWatchdogRun>;
};

const STORE_VERSION = 1;

export type LongRunWatchdogRun = {
  runId: string;
  channelId: string;
  messageId: string;
  sessionKey: string;
  status: RunStatus;
  startedAt: number;
  checkInDueAt: number;
  checkInPosted: boolean;
  checkInPostedAt: number | null;
  completion: CompletionKind | null;
  completedAt: number | null;
  finalPosted: boolean;
  finalPostAttempts: number;
  lastFinalAttemptAt: number | null;
  finalError: string | null;
  updatedAt: number;
};

export type StartLongRunInput = {
  runId: string;
  channelId: string;
  messageId: string;
  sessionKey?: string;
  stillRunningDelayMs?: number;
};

export type CompleteLongRunInput = {
  outcome: Exclude<CompletionKind, 'interrupted'>;
};

export type PostStillRunningSource = 'timer';
export type PostFinalSource = 'complete' | 'startup-sweep';

export type StartupSweepResult = {
  interruptedRuns: number;
  finalRetried: number;
  finalPosted: number;
  finalFailed: number;
};

export type LongRunWatchdogOpts = {
  dataFilePath: string;
  stillRunningDelayMs?: number;
  now?: () => number;
  postStillRunning: (run: LongRunWatchdogRun, meta: { source: PostStillRunningSource }) => Promise<void>;
  postFinal: (run: LongRunWatchdogRun, meta: { source: PostFinalSource }) => Promise<void>;
  log?: LoggerLike;
};

function emptyStore(): PersistedStore {
  return { version: STORE_VERSION, runs: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNullableFiniteNumber(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : null;
}

function asRunStatus(value: unknown, fallback: RunStatus): RunStatus {
  return value === 'running' || value === 'completed' ? value : fallback;
}

function asCompletionKind(value: unknown): CompletionKind | null {
  if (value === 'succeeded' || value === 'failed' || value === 'interrupted') return value;
  return null;
}

function normalizeRun(runId: string, raw: Record<string, unknown>, now: number): LongRunWatchdogRun | null {
  const channelId = asString(raw.channelId).trim();
  const messageId = asString(raw.messageId).trim();
  if (!channelId || !messageId) return null;

  const status = asRunStatus(raw.status, 'running');
  const startedAt = asFiniteNumber(raw.startedAt, now);
  const checkInDueAt = asFiniteNumber(raw.checkInDueAt, startedAt);
  const completion = asCompletionKind(raw.completion);
  const completedAt = asNullableFiniteNumber(raw.completedAt);
  const finalPosted = asBoolean(raw.finalPosted, false);

  return {
    runId,
    channelId,
    messageId,
    sessionKey: asString(raw.sessionKey),
    status,
    startedAt,
    checkInDueAt,
    checkInPosted: asBoolean(raw.checkInPosted, false),
    checkInPostedAt: asNullableFiniteNumber(raw.checkInPostedAt),
    completion,
    completedAt,
    finalPosted,
    finalPostAttempts: Math.max(0, Math.floor(asFiniteNumber(raw.finalPostAttempts, 0))),
    lastFinalAttemptAt: asNullableFiniteNumber(raw.lastFinalAttemptAt),
    finalError: asNullableString(raw.finalError),
    updatedAt: asFiniteNumber(raw.updatedAt, now),
  };
}

function cloneRun(run: LongRunWatchdogRun): LongRunWatchdogRun {
  return { ...run };
}

export class LongRunWatchdog {
  private readonly dataFilePath: string;
  private readonly stillRunningDelayMs: number;
  private readonly postStillRunning: LongRunWatchdogOpts['postStillRunning'];
  private readonly postFinal: LongRunWatchdogOpts['postFinal'];
  private readonly log?: LoggerLike;
  private readonly now: () => number;

  private loaded = false;
  private store: PersistedStore = emptyStore();
  private queue: Promise<void> = Promise.resolve();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private checkInInFlight = new Set<string>();
  private finalInFlight = new Set<string>();
  private startedRunIds = new Set<string>();

  constructor(opts: LongRunWatchdogOpts) {
    this.dataFilePath = opts.dataFilePath;
    this.stillRunningDelayMs = Math.max(1, opts.stillRunningDelayMs ?? 45_000);
    this.postStillRunning = opts.postStillRunning;
    this.postFinal = opts.postFinal;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
  }

  async start(input: StartLongRunInput): Promise<{ run: LongRunWatchdogRun; deduped: boolean }> {
    let out: { run: LongRunWatchdogRun; deduped: boolean } | null = null;
    await this.enqueue(async () => {
      await this.ensureLoaded();
      const existing = this.store.runs[input.runId];
      if (existing) {
        this.scheduleCheckInTimer(existing);
        out = { run: cloneRun(existing), deduped: true };
        return;
      }

      const now = this.now();
      const delayMs = Math.max(1, input.stillRunningDelayMs ?? this.stillRunningDelayMs);
      const run: LongRunWatchdogRun = {
        runId: input.runId,
        channelId: input.channelId,
        messageId: input.messageId,
        sessionKey: input.sessionKey ?? '',
        status: 'running',
        startedAt: now,
        checkInDueAt: now + delayMs,
        checkInPosted: false,
        checkInPostedAt: null,
        completion: null,
        completedAt: null,
        finalPosted: false,
        finalPostAttempts: 0,
        lastFinalAttemptAt: null,
        finalError: null,
        updatedAt: now,
      };
      this.store.runs[run.runId] = run;
      this.startedRunIds.add(run.runId);
      await this.persistStore();
      this.scheduleCheckInTimer(run);
      out = { run: cloneRun(run), deduped: false };
    });
    return out!;
  }

  async complete(runId: string, input: CompleteLongRunInput): Promise<LongRunWatchdogRun | null> {
    let out: LongRunWatchdogRun | null = null;
    await this.enqueue(async () => {
      await this.ensureLoaded();
      const run = this.store.runs[runId];
      if (!run) return;

      if (run.status !== 'completed') {
        run.status = 'completed';
        run.completion = input.outcome;
        run.completedAt = this.now();
      }
      run.updatedAt = this.now();
      await this.persistStore();
      this.clearCheckInTimer(run.runId);
      out = cloneRun(run);
    });

    if (!out) return null;
    await this.postFinalIfNeeded(runId, 'complete');
    return this.getRun(runId);
  }

  async getRun(runId: string): Promise<LongRunWatchdogRun | null> {
    let out: LongRunWatchdogRun | null = null;
    await this.enqueue(async () => {
      await this.ensureLoaded();
      const run = this.store.runs[runId];
      out = run ? cloneRun(run) : null;
    });
    return out;
  }

  async listRuns(): Promise<LongRunWatchdogRun[]> {
    let out: LongRunWatchdogRun[] = [];
    await this.enqueue(async () => {
      await this.ensureLoaded();
      out = Object.values(this.store.runs).map((run) => cloneRun(run));
    });
    return out;
  }

  async startupSweep(): Promise<StartupSweepResult> {
    const runIdsToRetry: string[] = [];
    let interruptedRuns = 0;

    await this.enqueue(async () => {
      await this.ensureLoaded();
      const now = this.now();
      let changed = false;

      for (const run of Object.values(this.store.runs)) {
        if (run.status === 'running') {
          if (this.startedRunIds.has(run.runId)) {
            this.scheduleCheckInTimer(run);
            continue;
          }
          this.clearCheckInTimer(run.runId);
          run.status = 'completed';
          run.completion = 'interrupted';
          run.completedAt = now;
          run.updatedAt = now;
          run.finalPosted = false;
          run.finalError = null;
          interruptedRuns++;
          changed = true;
        } else {
          this.clearCheckInTimer(run.runId);
        }
        if (run.status === 'completed' && !run.finalPosted && this.requiresFinalPost(run)) {
          runIdsToRetry.push(run.runId);
        }
      }

      if (changed) {
        await this.persistStore();
      }
    });

    let finalPosted = 0;
    let finalFailed = 0;
    for (const runId of runIdsToRetry) {
      const ok = await this.postFinalIfNeeded(runId, 'startup-sweep');
      if (ok) finalPosted++;
      else {
        const run = await this.getRun(runId);
        if (run && !run.finalPosted) finalFailed++;
      }
    }

    return {
      interruptedRuns,
      finalRetried: runIdsToRetry.length,
      finalPosted,
      finalFailed,
    };
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  _waitForIdleForTest(): Promise<void> {
    return this.queue;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.store = await this.readStore();
    this.loaded = true;
    for (const run of Object.values(this.store.runs)) {
      this.scheduleCheckInTimer(run);
    }
  }

  private async readStore(): Promise<PersistedStore> {
    try {
      const raw = await fs.readFile(this.dataFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return emptyStore();
      if (parsed.version !== STORE_VERSION) return emptyStore();
      const runsRaw = parsed.runs;
      if (!isRecord(runsRaw)) return emptyStore();

      const now = this.now();
      const runs: Record<string, LongRunWatchdogRun> = {};
      for (const [runId, value] of Object.entries(runsRaw)) {
        if (!isRecord(value)) continue;
        const normalized = normalizeRun(runId, value, now);
        if (normalized) runs[runId] = normalized;
      }
      return { version: STORE_VERSION, runs };
    } catch {
      return emptyStore();
    }
  }

  private async persistStore(): Promise<void> {
    const dir = path.dirname(this.dataFilePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.dataFilePath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(tmpPath, JSON.stringify(this.store, null, 2) + '\n', 'utf-8');
    await fs.rename(tmpPath, this.dataFilePath);
  }

  private clearCheckInTimer(runId: string): void {
    const timer = this.timers.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(runId);
  }

  private scheduleCheckInTimer(run: LongRunWatchdogRun): void {
    if (run.status !== 'running' || run.checkInPosted) {
      this.clearCheckInTimer(run.runId);
      return;
    }
    if (this.timers.has(run.runId)) return;
    const delayMs = Math.max(0, run.checkInDueAt - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(run.runId);
      void this.postCheckInIfNeeded(run.runId, 'timer');
    }, delayMs);
    this.timers.set(run.runId, timer);
  }

  private async postCheckInIfNeeded(runId: string, source: PostStillRunningSource): Promise<boolean> {
    if (this.checkInInFlight.has(runId)) return false;
    this.checkInInFlight.add(runId);
    let snapshot: LongRunWatchdogRun | null = null;

    try {
      await this.enqueue(async () => {
        await this.ensureLoaded();
        const run = this.store.runs[runId];
        if (!run) return;
        if (run.status !== 'running' || run.checkInPosted) return;
        snapshot = cloneRun(run);
      });

      if (!snapshot) return false;

      await this.postStillRunning(snapshot, { source });

      await this.enqueue(async () => {
        const run = this.store.runs[runId];
        if (!run) return;
        if (run.status !== 'running' || run.checkInPosted) return;
        run.checkInPosted = true;
        run.checkInPostedAt = this.now();
        run.updatedAt = this.now();
        await this.persistStore();
      });
      return true;
    } catch (err) {
      this.log?.warn({ err, runId }, 'long-run-watchdog: check-in post failed');
      return false;
    } finally {
      this.checkInInFlight.delete(runId);
    }
  }

  private async postFinalIfNeeded(runId: string, source: PostFinalSource): Promise<boolean> {
    if (this.finalInFlight.has(runId)) return false;
    this.finalInFlight.add(runId);
    let snapshot: LongRunWatchdogRun | null = null;

    try {
      await this.enqueue(async () => {
        await this.ensureLoaded();
        const run = this.store.runs[runId];
        if (!run) return;
        if (run.status !== 'completed' || run.finalPosted || !this.requiresFinalPost(run)) return;

        run.finalPostAttempts += 1;
        run.lastFinalAttemptAt = this.now();
        run.updatedAt = this.now();
        await this.persistStore();
        snapshot = cloneRun(run);
      });

      if (!snapshot) return false;

      await this.postFinal(snapshot, { source });

      await this.enqueue(async () => {
        const run = this.store.runs[runId];
        if (!run) return;
        if (run.status !== 'completed') return;
        run.finalPosted = true;
        run.finalError = null;
        run.updatedAt = this.now();
        await this.persistStore();
      });
      return true;
    } catch (err) {
      await this.enqueue(async () => {
        const run = this.store.runs[runId];
        if (!run || run.finalPosted) return;
        run.finalError = err instanceof Error ? err.message : String(err);
        run.updatedAt = this.now();
        await this.persistStore();
      });
      this.log?.warn({ err, runId }, 'long-run-watchdog: final post failed');
      return false;
    } finally {
      this.finalInFlight.delete(runId);
    }
  }

  private requiresFinalPost(run: LongRunWatchdogRun): boolean {
    if (run.completion === 'interrupted') return true;
    if (run.checkInPosted) return true;
    if (run.completedAt !== null && run.completedAt >= run.checkInDueAt) return true;
    return false;
  }
}
