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
    expect(store.version).toBe(9);
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

  it('upserts with allowedActions and retrieves it', async () => {
    const stats = await loadRunStats(statsPath);
    const rec = await stats.upsertRecord('cron-aa1', 'thread-aa1', { allowedActions: ['sendMessage', 'cronList'] });
    expect(rec.allowedActions).toEqual(['sendMessage', 'cronList']);

    const fetched = stats.getRecord('cron-aa1');
    expect(fetched!.allowedActions).toEqual(['sendMessage', 'cronList']);
  });

  it('persists allowedActions through disk reload', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-aa2', 'thread-aa2', { allowedActions: ['cronShow'] });

    const stats2 = await loadRunStats(statsPath);
    const rec = stats2.getRecord('cron-aa2');
    expect(rec).toBeDefined();
    expect(rec!.allowedActions).toEqual(['cronShow']);
  });

  it('clears allowedActions when upserted with undefined and removes the key in-memory', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-aa3', 'thread-aa3', { allowedActions: ['cronList'] });
    expect(stats.getRecord('cron-aa3')!.allowedActions).toEqual(['cronList']);

    await stats.upsertRecord('cron-aa3', 'thread-aa3', { allowedActions: undefined });
    const rec = stats.getRecord('cron-aa3')!;
    expect(rec.allowedActions).toBeUndefined();
    // Key must not be present in-memory (not just set to undefined).
    expect('allowedActions' in rec).toBe(false);
  });

  it('cleared allowedActions does not reappear after disk reload', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-aa4', 'thread-aa4', { allowedActions: ['sendMessage'] });
    await stats.upsertRecord('cron-aa4', 'thread-aa4', { allowedActions: undefined });

    const stats2 = await loadRunStats(statsPath);
    const rec = stats2.getRecord('cron-aa4')!;
    expect(rec.allowedActions).toBeUndefined();
    expect('allowedActions' in rec).toBe(false);
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

  it('recordRunStart sets running status and startedAt', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-rs1', 'thread-rs1');
    await stats.recordRunStart('cron-rs1');

    const rec = stats.getRecord('cron-rs1')!;
    expect(rec.lastRunStatus).toBe('running');
    expect(rec.startedAt).toBeTruthy();
  });

  it('recordRunStart does not increment runCount', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-rs2', 'thread-rs2');
    await stats.recordRunStart('cron-rs2');

    const rec = stats.getRecord('cron-rs2')!;
    expect(rec.runCount).toBe(0);
  });

  it('recordRunStart no-ops for unknown cronId', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.recordRunStart('nonexistent');
    // Should not throw
  });

  it('sweepInterrupted promotes running entries to interrupted', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-sw1', 'thread-sw1');
    await stats.upsertRecord('cron-sw2', 'thread-sw2');
    await stats.recordRunStart('cron-sw1');
    await stats.recordRunStart('cron-sw2');

    const affected = await stats.sweepInterrupted();
    expect(affected).toHaveLength(2);
    expect(affected).toContain('cron-sw1');
    expect(affected).toContain('cron-sw2');

    expect(stats.getRecord('cron-sw1')!.lastRunStatus).toBe('interrupted');
    expect(stats.getRecord('cron-sw2')!.lastRunStatus).toBe('interrupted');
  });

  it('sweepInterrupted leaves non-running entries untouched', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-sw3', 'thread-sw3');
    await stats.upsertRecord('cron-sw4', 'thread-sw4');
    await stats.recordRun('cron-sw3', 'success');
    await stats.recordRun('cron-sw4', 'error', 'oops');

    const affected = await stats.sweepInterrupted();
    expect(affected).toHaveLength(0);
    expect(stats.getRecord('cron-sw3')!.lastRunStatus).toBe('success');
    expect(stats.getRecord('cron-sw4')!.lastRunStatus).toBe('error');
  });

  it('sweepInterrupted returns empty array when no running entries', async () => {
    const stats = await loadRunStats(statsPath);
    const affected = await stats.sweepInterrupted();
    expect(affected).toHaveLength(0);
  });

  it('sweepInterrupted persists interrupted status to disk', async () => {
    const stats = await loadRunStats(statsPath);
    await stats.upsertRecord('cron-sw5', 'thread-sw5');
    await stats.recordRunStart('cron-sw5');
    await stats.sweepInterrupted();

    const stats2 = await loadRunStats(statsPath);
    expect(stats2.getRecord('cron-sw5')!.lastRunStatus).toBe('interrupted');
  });
});

describe('emptyStore', () => {
  it('returns valid initial structure', () => {
    const store = emptyStore();
    expect(store.version).toBe(9);
    expect(store.updatedAt).toBeGreaterThan(0);
    expect(Object.keys(store.jobs)).toHaveLength(0);
  });
});

describe('loadRunStats version migration', () => {
  it('migrates a v3 store to v4 and preserves existing records', async () => {
    const v3Store = {
      version: 3,
      updatedAt: Date.now(),
      jobs: {
        'cron-migrated': {
          cronId: 'cron-migrated',
          threadId: 'thread-migrate',
          runCount: 5,
          lastRunAt: '2025-01-01T00:00:00.000Z',
          lastRunStatus: 'success',
          cadence: 'daily',
          purposeTags: ['monitoring'],
          disabled: false,
          model: 'haiku',
          triggerType: 'schedule',
        },
      },
    };
    await fs.writeFile(statsPath, JSON.stringify(v3Store), 'utf-8');

    const stats = await loadRunStats(statsPath);

    expect(stats.getStore().version).toBe(9);
    const rec = stats.getRecord('cron-migrated');
    expect(rec).toBeDefined();
    expect(rec!.cronId).toBe('cron-migrated');
    expect(rec!.runCount).toBe(5);
    expect(rec!.lastRunStatus).toBe('success');
    expect(rec!.cadence).toBe('daily');
    expect(rec!.purposeTags).toEqual(['monitoring']);
  });

  it('migrates a v4 store to v5 with silent undefined on existing records', async () => {
    const v4Store = {
      version: 4,
      updatedAt: Date.now(),
      jobs: {
        'cron-v4': {
          cronId: 'cron-v4',
          threadId: 'thread-v4',
          runCount: 3,
          lastRunAt: '2025-06-01T00:00:00.000Z',
          lastRunStatus: 'success',
          cadence: 'hourly',
          purposeTags: ['email'],
          disabled: false,
          model: 'sonnet',
          triggerType: 'schedule',
        },
      },
    };
    await fs.writeFile(statsPath, JSON.stringify(v4Store), 'utf-8');

    const stats = await loadRunStats(statsPath);

    expect(stats.getStore().version).toBe(9);
    const rec = stats.getRecord('cron-v4');
    expect(rec).toBeDefined();
    expect(rec!.cronId).toBe('cron-v4');
    expect(rec!.runCount).toBe(3);
    expect(rec!.cadence).toBe('hourly');
    expect(rec!.silent).toBeUndefined();
  });

  it('migrates a v5 store to v6 with definition fields undefined on existing records', async () => {
    const v5Store = {
      version: 5,
      updatedAt: Date.now(),
      jobs: {
        'cron-v5': {
          cronId: 'cron-v5',
          threadId: 'thread-v5',
          runCount: 7,
          lastRunAt: '2025-08-01T00:00:00.000Z',
          lastRunStatus: 'success',
          cadence: 'daily',
          purposeTags: ['greeting'],
          disabled: false,
          model: 'haiku',
          triggerType: 'schedule',
          silent: true,
        },
      },
    };
    await fs.writeFile(statsPath, JSON.stringify(v5Store), 'utf-8');

    const stats = await loadRunStats(statsPath);

    expect(stats.getStore().version).toBe(9);
    const rec = stats.getRecord('cron-v5');
    expect(rec).toBeDefined();
    expect(rec!.cronId).toBe('cron-v5');
    expect(rec!.runCount).toBe(7);
    expect(rec!.cadence).toBe('daily');
    expect(rec!.silent).toBe(true);
    expect(rec!.schedule).toBeUndefined();
    expect(rec!.timezone).toBeUndefined();
    expect(rec!.channel).toBeUndefined();
    expect(rec!.prompt).toBeUndefined();
    expect(rec!.authorId).toBeUndefined();
  });

  it('migrates a v6 store to v7 with routingMode and allowedActions undefined on existing records', async () => {
    const v6Store = {
      version: 6,
      updatedAt: Date.now(),
      jobs: {
        'cron-v6': {
          cronId: 'cron-v6',
          threadId: 'thread-v6',
          runCount: 2,
          lastRunAt: '2026-01-01T00:00:00.000Z',
          lastRunStatus: 'success',
          cadence: 'daily',
          purposeTags: [],
          disabled: false,
          model: 'sonnet',
          triggerType: 'schedule',
          silent: false,
          channel: 'general',
        },
      },
    };
    await fs.writeFile(statsPath, JSON.stringify(v6Store), 'utf-8');

    const stats = await loadRunStats(statsPath);

    expect(stats.getStore().version).toBe(9);
    const rec = stats.getRecord('cron-v6');
    expect(rec).toBeDefined();
    expect(rec!.cronId).toBe('cron-v6');
    expect(rec!.runCount).toBe(2);
    expect(rec!.routingMode).toBeUndefined();
    expect(rec!.allowedActions).toBeUndefined();
  });
});
