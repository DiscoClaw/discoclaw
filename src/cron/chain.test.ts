import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fireChainedJobs } from './executor.js';
import type { CronExecutorContext } from './executor.js';
import type { CronJob } from './types.js';
import { loadRunStats } from './run-stats.js';
import type { CronRunStats } from './run-stats.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chain-test-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeStatsStore(): Promise<CronRunStats> {
  return loadRunStats(path.join(tmpDir, 'stats.json'));
}

function makeDownstreamJob(cronId: string, threadId: string): CronJob {
  return {
    id: threadId,
    cronId,
    threadId,
    guildId: 'guild-1',
    name: `Job ${cronId}`,
    def: { triggerType: 'schedule', schedule: '0 0 * * *', timezone: 'UTC', channel: 'general', prompt: 'test' },
    cron: null,
    running: false,
  };
}

function makeMinimalCtx(statsStore: CronRunStats, overrides?: Partial<CronExecutorContext>): CronExecutorContext {
  return {
    client: {} as any,
    runtime: { id: 'claude_code', capabilities: new Set(), async *invoke() {} } as any,
    model: 'haiku',
    cwd: '/tmp',
    tools: [],
    timeoutMs: 30_000,
    status: null,
    log: mockLog(),
    discordActionsEnabled: false,
    actionFlags: {
      channels: false, messaging: false, guild: false, moderation: false,
      polls: false, tasks: false, crons: false, botProfile: false,
      forge: false, plan: false, memory: false, config: false, defer: false, voice: false,
    },
    statsStore,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fireChainedJobs
// ---------------------------------------------------------------------------

describe('fireChainedJobs', () => {
  it('does nothing when getSchedulerJob is not set', async () => {
    const store = await makeStatsStore();
    await store.upsertRecord('upstream', 'thread-up', { chain: ['downstream'] });
    await store.upsertRecord('downstream', 'thread-down', {});

    const ctx = makeMinimalCtx(store);
    // No getSchedulerJob → early return
    await fireChainedJobs('upstream', ctx);

    const rec = store.getRecord('downstream');
    // State should NOT have been forwarded
    expect(rec?.state).toBeUndefined();
  });

  it('does nothing when statsStore is not set', async () => {
    const ctx = makeMinimalCtx(undefined as any, { statsStore: undefined });
    // Should not throw
    await fireChainedJobs('upstream', ctx);
  });

  it('does nothing when the upstream job has no chain', async () => {
    const store = await makeStatsStore();
    await store.upsertRecord('upstream', 'thread-up', {});

    const getSchedulerJob = vi.fn();
    const ctx = makeMinimalCtx(store, { getSchedulerJob });
    await fireChainedJobs('upstream', ctx);

    expect(getSchedulerJob).not.toHaveBeenCalled();
  });

  it('does nothing when chain is empty array', async () => {
    const store = await makeStatsStore();
    await store.upsertRecord('upstream', 'thread-up', { chain: [] });

    const getSchedulerJob = vi.fn();
    const ctx = makeMinimalCtx(store, { getSchedulerJob });
    await fireChainedJobs('upstream', ctx);

    expect(getSchedulerJob).not.toHaveBeenCalled();
  });

  it('forwards __upstream state to downstream job', async () => {
    const store = await makeStatsStore();
    const upstreamState = { lastSeenTag: 'v2.3.1', items: [1, 2, 3] };
    await store.upsertRecord('upstream', 'thread-up', {
      chain: ['downstream'],
      state: upstreamState,
    });
    await store.upsertRecord('downstream', 'thread-down', {
      state: { existingKey: 'preserved' },
    });

    const downstreamJob = makeDownstreamJob('downstream', 'thread-down');
    const getSchedulerJob = vi.fn().mockReturnValue(downstreamJob);
    const ctx = makeMinimalCtx(store, { getSchedulerJob });
    await fireChainedJobs('upstream', ctx);

    const rec = store.getRecord('downstream');
    expect(rec?.state).toEqual({
      existingKey: 'preserved',
      __upstream: { fromCronId: 'upstream', state: upstreamState },
    });
  });

  it('forwards empty state as __upstream when upstream has no state', async () => {
    const store = await makeStatsStore();
    await store.upsertRecord('upstream', 'thread-up', { chain: ['downstream'] });
    await store.upsertRecord('downstream', 'thread-down', {});

    const downstreamJob = makeDownstreamJob('downstream', 'thread-down');
    const getSchedulerJob = vi.fn().mockReturnValue(downstreamJob);
    const ctx = makeMinimalCtx(store, { getSchedulerJob });
    await fireChainedJobs('upstream', ctx);

    const rec = store.getRecord('downstream');
    expect(rec?.state).toEqual({
      __upstream: { fromCronId: 'upstream', state: {} },
    });
  });

  it('skips downstream when record is not found', async () => {
    const store = await makeStatsStore();
    await store.upsertRecord('upstream', 'thread-up', { chain: ['nonexistent'] });

    const getSchedulerJob = vi.fn();
    const log = mockLog();
    const ctx = makeMinimalCtx(store, { getSchedulerJob, log });
    await fireChainedJobs('upstream', ctx);

    expect(getSchedulerJob).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ downstream: 'nonexistent' }),
      expect.stringContaining('record not found'),
    );
  });

  it('skips downstream when scheduler job is not found', async () => {
    const store = await makeStatsStore();
    await store.upsertRecord('upstream', 'thread-up', { chain: ['downstream'] });
    await store.upsertRecord('downstream', 'thread-down', {});

    const getSchedulerJob = vi.fn().mockReturnValue(undefined);
    const log = mockLog();
    const ctx = makeMinimalCtx(store, { getSchedulerJob, log });
    await fireChainedJobs('upstream', ctx);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ downstream: 'downstream' }),
      expect.stringContaining('scheduler job not found'),
    );
  });

  it('fires multiple downstream jobs independently', async () => {
    const store = await makeStatsStore();
    await store.upsertRecord('upstream', 'thread-up', {
      chain: ['down-a', 'down-b'],
      state: { data: 42 },
    });
    await store.upsertRecord('down-a', 'thread-a', {});
    await store.upsertRecord('down-b', 'thread-b', {});

    const jobA = makeDownstreamJob('down-a', 'thread-a');
    const jobB = makeDownstreamJob('down-b', 'thread-b');
    const getSchedulerJob = vi.fn((threadId: string) => {
      if (threadId === 'thread-a') return jobA;
      if (threadId === 'thread-b') return jobB;
      return undefined;
    });

    const log = mockLog();
    const ctx = makeMinimalCtx(store, { getSchedulerJob, log });
    await fireChainedJobs('upstream', ctx);

    // Both should have __upstream state forwarded
    const recA = store.getRecord('down-a');
    const recB = store.getRecord('down-b');
    expect(recA?.state?.__upstream).toEqual({ fromCronId: 'upstream', state: { data: 42 } });
    expect(recB?.state?.__upstream).toEqual({ fromCronId: 'upstream', state: { data: 42 } });

    // Both should have been logged as fired
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ downstream: 'down-a' }),
      expect.stringContaining('downstream fired'),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ downstream: 'down-b' }),
      expect.stringContaining('downstream fired'),
    );
  });

  it('logs warning and skips downstream when chain depth >= 10', async () => {
    const store = await makeStatsStore();
    await store.upsertRecord('upstream', 'thread-up', { chain: ['downstream'] });
    await store.upsertRecord('downstream', 'thread-down', {});

    const getSchedulerJob = vi.fn();
    const log = mockLog();
    const ctx = makeMinimalCtx(store, { getSchedulerJob, log, chainDepth: 10 });
    await fireChainedJobs('upstream', ctx);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cronId: 'upstream', chainDepth: 10 }),
      expect.stringContaining('depth limit'),
    );
    // getSchedulerJob should never be called — we returned early
    expect(getSchedulerJob).not.toHaveBeenCalled();
  });

  it('increments chain depth for downstream execution context', async () => {
    const store = await makeStatsStore();
    await store.upsertRecord('upstream', 'thread-up', {
      chain: ['downstream'],
      state: { x: 1 },
    });
    await store.upsertRecord('downstream', 'thread-down', {});

    const downstreamJob = makeDownstreamJob('downstream', 'thread-down');
    const getSchedulerJob = vi.fn().mockReturnValue(downstreamJob);
    const log = mockLog();
    const ctx = makeMinimalCtx(store, { getSchedulerJob, log, chainDepth: 5 });
    await fireChainedJobs('upstream', ctx);

    // The function should have fired (depth 5 < 10)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ downstream: 'downstream' }),
      expect.stringContaining('downstream fired'),
    );
  });

  it('handles state forward failure gracefully', async () => {
    const store = await makeStatsStore();
    await store.upsertRecord('upstream', 'thread-up', {
      chain: ['downstream'],
      state: { data: 1 },
    });
    await store.upsertRecord('downstream', 'thread-down', {});

    // Mock upsertRecord to fail on state forwarding
    const originalUpsert = store.upsertRecord.bind(store);
    let callCount = 0;
    vi.spyOn(store, 'upsertRecord').mockImplementation(async (...args) => {
      callCount++;
      // Fail on the state-forwarding call (the one during fireChainedJobs)
      if (callCount > 0) throw new Error('disk full');
      return originalUpsert(...args);
    });

    const downstreamJob = makeDownstreamJob('downstream', 'thread-down');
    const getSchedulerJob = vi.fn().mockReturnValue(downstreamJob);
    const log = mockLog();
    const ctx = makeMinimalCtx(store, { getSchedulerJob, log });
    await fireChainedJobs('upstream', ctx);

    // Should log a warning but still fire downstream
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ downstream: 'downstream' }),
      expect.stringContaining('state forward failed'),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ downstream: 'downstream' }),
      expect.stringContaining('downstream fired'),
    );
  });
});
