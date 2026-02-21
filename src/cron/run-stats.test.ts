import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  CronRunStats,
  loadRunStats,
  emptyStore,
  generateCronId,
  parseCronIdFromContent,
} from './run-stats.js';

let tmpDir: string;
let statsPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-stats-'));
  statsPath = path.join(tmpDir, 'cron-run-stats.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('generateCronId', () => {
  it('produces cron-prefixed hex IDs', () => {
    const id = generateCronId();
    expect(id).toMatch(/^cron-[a-f0-9]{8}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCronId()));
    expect(ids.size).toBe(100);
  });
});

describe('parseCronIdFromContent', () => {
  it('extracts cronId from status message content', () => {
    const content = '📊 **Cron Status** [cronId:cron-a1b2c3d4]\n**Last run:** ...';
    expect(parseCronIdFromContent(content)).toBe('cron-a1b2c3d4');
  });

  it('returns null when no cronId token present', () => {
    expect(parseCronIdFromContent('Just some text')).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(parseCronIdFromContent('')).toBeNull();
  });
});

describe('CronRunStats', () => {
  it('creates empty store on missing file', async () => {
    const stats = await loadRunStats(statsPath);
    const store = stats.getStore();
    expect(store.version).toBe(2);
    expect(Object.keys(store.jobs)).toHaveLength(0);
  });

  it('upserts and retrieves records by cronId', async () => {
    const stats = await loadRunStats(statsPath);
    const rec = await stats.upsertRecord('cron-test1', 'thread-1');
    expect(rec.cronId).toBe('cron-test1');
    expect(rec.threadId).toBe('thread-1');
    expect(rec.runCount).toBe(0);

    const fetched = stats.getRecord('cron-test1');
    expect(fetched).toBeDefined();
    expect(fetched!.threadId).toBe('thread-1');
  });

  it('upserts with partial updates', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-test2', 'thread-2');
    const updated = await stats.upsertRecord('cron-test2', 'thread-2', { cadence: 'daily', model: 'haiku' });
    expect(updated.cadence).toBe('daily');
    expect(updated.model).toBe('haiku');
  });

  it('retrieves records by threadId', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-a', 'thread-100');
    const rec = stats.getRecordByThreadId('thread-100');
    expect(rec).toBeDefined();
    expect(rec!.cronId).toBe('cron-a');
  });

  it('retrieves records by statusMessageId', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-b', 'thread-200', { statusMessageId: 'status-1' });
    const rec = stats.getRecordByStatusMessageId('status-1');
    expect(rec).toBeDefined();
    expect(rec!.cronId).toBe('cron-b');
  });

  it('returns undefined for unknown cronId', async () => {
    const stats = await loadRunStats(statsPath);
    expect(stats.getRecord('nonexistent')).toBeUndefined();
  });

  it('returns undefined for unknown threadId', async () => {
    const stats = await loadRunStats(statsPath);
    expect(stats.getRecordByThreadId('nonexistent')).toBeUndefined();
  });

  it('returns undefined for unknown statusMessageId', async () => {
    const stats = await loadRunStats(statsPath);
    expect(stats.getRecordByStatusMessageId('missing')).toBeUndefined();
  });

  it('records successful runs', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-r1', 'thread-r1');
    await stats.recordRun('cron-r1', 'success');

    const rec = stats.getRecord('cron-r1')!;
    expect(rec.runCount).toBe(1);
    expect(rec.lastRunStatus).toBe('success');
    expect(rec.lastRunAt).toBeTruthy();
    expect(rec.lastErrorMessage).toBeUndefined();
  });

  it('records error runs with capped message', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-r2', 'thread-r2');
    const longMsg = 'x'.repeat(300);
    await stats.recordRun('cron-r2', 'error', longMsg);

    const rec = stats.getRecord('cron-r2')!;
    expect(rec.runCount).toBe(1);
    expect(rec.lastRunStatus).toBe('error');
    expect(rec.lastErrorMessage).toHaveLength(200);
  });

  it('increments runCount across multiple runs', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-r3', 'thread-r3');
    await stats.recordRun('cron-r3', 'success');
    await stats.recordRun('cron-r3', 'success');
    await stats.recordRun('cron-r3', 'error', 'oops');

    const rec = stats.getRecord('cron-r3')!;
    expect(rec.runCount).toBe(3);
    expect(rec.lastRunStatus).toBe('error');
  });

  it('removes record by cronId', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-del', 'thread-del');
    const removed = await stats.removeRecord('cron-del');
    expect(removed).toBe(true);
    expect(stats.getRecord('cron-del')).toBeUndefined();
  });

  it('returns false when removing nonexistent cronId', async () => {
    const stats = await loadRunStats(statsPath);
    const removed = await stats.removeRecord('nope');
    expect(removed).toBe(false);
  });

  it('removes record by threadId', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-dt', 'thread-dt');
    const removed = await stats.removeByThreadId('thread-dt');
    expect(removed).toBe(true);
    expect(stats.getRecordByThreadId('thread-dt')).toBeUndefined();
  });

  it('persists to disk and survives reload', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-persist', 'thread-p', { cadence: 'weekly', purposeTags: ['monitoring'] });
    await stats.recordRun('cron-persist', 'success');

    const stats2 = await loadRunStats(statsPath);
    const rec = stats2.getRecord('cron-persist');
    expect(rec).toBeDefined();
    expect(rec!.cadence).toBe('weekly');
    expect(rec!.runCount).toBe(1);
    expect(rec!.purposeTags).toEqual(['monitoring']);
  });

  it('no-ops recordRun for unknown cronId', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.recordRun('nonexistent', 'success');
    // Should not throw
  });
});

describe('emptyStore', () => {
  it('returns valid initial structure', () => {
    const store = emptyStore();
    expect(store.version).toBe(2);
    expect(store.updatedAt).toBeGreaterThan(0);
    expect(Object.keys(store.jobs)).toHaveLength(0);
  });
});
