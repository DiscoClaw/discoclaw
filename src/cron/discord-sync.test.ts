import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildCronThreadName, stripCadencePrefix, formatStatusMessage, seedTagMap, ensureStatusMessage, resolveForumChannel } from './discord-sync.js';
import type { CronRunRecord, CronRunStats } from './run-stats.js';

describe('buildCronThreadName', () => {
  it('prefixes with cadence emoji', () => {
    expect(buildCronThreadName('Morning Report', 'daily')).toBe('\uD83C\uDF05 Morning Report');
  });

  it('uses frequent emoji', () => {
    expect(buildCronThreadName('Health Check', 'frequent')).toBe('\u23F1\uFE0F Health Check');
  });

  it('omits emoji when cadence is null', () => {
    expect(buildCronThreadName('Some Job', null)).toBe('Some Job');
  });

  it('truncates long names to 100 chars', () => {
    const longName = 'x'.repeat(120);
    const result = buildCronThreadName(longName, 'daily');
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain('\u2026');
  });

  it('strips existing emoji prefix before prepending', () => {
    expect(buildCronThreadName('\uD83C\uDF05 Morning Report', 'daily')).toBe('\uD83C\uDF05 Morning Report');
  });

  it('strips accumulated prefixes', () => {
    expect(buildCronThreadName('\uD83C\uDF05 \uD83C\uDF05 \uD83C\uDF05 Morning Report', 'daily')).toBe('\uD83C\uDF05 Morning Report');
  });

  it('corrects wrong cadence emoji', () => {
    expect(buildCronThreadName('\uD83D\uDD50 Morning Report', 'daily')).toBe('\uD83C\uDF05 Morning Report');
  });

  it('strips mixed accumulated prefixes', () => {
    expect(buildCronThreadName('\uD83C\uDF05 \uD83D\uDD50 Morning Report', 'daily')).toBe('\uD83C\uDF05 Morning Report');
  });

  it('is idempotent', () => {
    const once = buildCronThreadName('Report', 'daily');
    const twice = buildCronThreadName(once, 'daily');
    expect(twice).toBe(once);
  });

  it('handles null cadence with prefixed name', () => {
    expect(buildCronThreadName('\uD83C\uDF05 Morning Report', null)).toBe('Morning Report');
  });

  it('handles emoji with VS16 from Discord normalization', () => {
    expect(buildCronThreadName('\u23F1\uFE0F Health Check', 'frequent')).toBe('\u23F1\uFE0F Health Check');
  });

  it('handles emoji without VS16 from old data', () => {
    expect(buildCronThreadName('\u23F1 Health Check', 'frequent')).toBe('\u23F1\uFE0F Health Check');
  });

  it('preserves VS16 in base name', () => {
    expect(buildCronThreadName('\uD83C\uDF05 Test \u2600\uFE0F Dashboard', 'daily')).toBe('\uD83C\uDF05 Test \u2600\uFE0F Dashboard');
  });
});

describe('stripCadencePrefix', () => {
  it('strips single prefix', () => {
    expect(stripCadencePrefix('\uD83C\uDF05 Test')).toBe('Test');
  });

  it('strips multiple accumulated', () => {
    expect(stripCadencePrefix('\uD83C\uDF05 \uD83C\uDF05 \uD83C\uDF05 Test')).toBe('Test');
  });

  it('strips mixed cadence emojis', () => {
    expect(stripCadencePrefix('\uD83D\uDD50 \uD83C\uDF05 Test')).toBe('Test');
  });

  it('no-op for clean name', () => {
    expect(stripCadencePrefix('Test')).toBe('Test');
  });

  it('no-op for empty string', () => {
    expect(stripCadencePrefix('')).toBe('');
  });

  it('preserves non-cadence emoji', () => {
    expect(stripCadencePrefix('\u26A1 Test')).toBe('\u26A1 Test');
  });

  it('strips prefix with VS16 variation selector', () => {
    expect(stripCadencePrefix('\u23F1\uFE0F Test')).toBe('Test');
  });

  it('strips accumulated prefixes with mixed VS16', () => {
    expect(stripCadencePrefix('\u23F1\uFE0F \u23F1 Test')).toBe('Test');
  });

  it('preserves VS16 in base name', () => {
    expect(stripCadencePrefix('\uD83C\uDF05 Test \u2600\uFE0F Dashboard')).toBe('Test \u2600\uFE0F Dashboard');
  });

  it('preserves VS16 in base name when prefix also has VS16', () => {
    expect(stripCadencePrefix('\u23F1\uFE0F Test \u2600\uFE0F End')).toBe('Test \u2600\uFE0F End');
  });
});

describe('formatStatusMessage', () => {
  it('includes cronId token', () => {
    const record: CronRunRecord = {
      cronId: 'cron-abc12345',
      threadId: 'thread-1',
      runCount: 5,
      lastRunAt: '2025-01-15T10:00:00Z',
      lastRunStatus: 'success',
      cadence: 'daily',
      purposeTags: ['monitoring', 'cleanup'],
      disabled: false,
      model: 'haiku',
    };
    const msg = formatStatusMessage('cron-abc12345', record);
    expect(msg).toContain('[cronId:cron-abc12345]');
    expect(msg).toContain('Runs:** 5');
    expect(msg).toContain('haiku');
    expect(msg).toContain('daily');
    expect(msg).toContain('monitoring, cleanup');
  });

  it('shows error details', () => {
    const record: CronRunRecord = {
      cronId: 'cron-err1',
      threadId: 'thread-2',
      runCount: 1,
      lastRunAt: '2025-01-15T10:00:00Z',
      lastRunStatus: 'error',
      lastErrorMessage: 'timeout exceeded',
      cadence: null,
      purposeTags: [],
      disabled: false,
      model: null,
    };
    const msg = formatStatusMessage('cron-err1', record);
    expect(msg).toContain('\u274C');
    expect(msg).toContain('timeout exceeded');
  });

  it('shows model override when present', () => {
    const record: CronRunRecord = {
      cronId: 'cron-ovr',
      threadId: 'thread-3',
      runCount: 0,
      lastRunAt: null,
      lastRunStatus: null,
      cadence: 'hourly',
      purposeTags: [],
      disabled: false,
      model: 'haiku',
      modelOverride: 'opus',
    };
    const msg = formatStatusMessage('cron-ovr', record);
    expect(msg).toContain('opus');
  });

  it('includes "Currently running" when running is true', () => {
    const record: CronRunRecord = {
      cronId: 'cron-run1',
      threadId: 'thread-1',
      runCount: 3,
      lastRunAt: '2025-01-15T10:00:00Z',
      lastRunStatus: 'success',
      cadence: 'daily',
      purposeTags: [],
      disabled: false,
      model: 'haiku',
    };
    const msg = formatStatusMessage('cron-run1', record, true);
    expect(msg).toContain('Currently running');
  });

  it('does not include "Currently running" when running is false', () => {
    const record: CronRunRecord = {
      cronId: 'cron-run2',
      threadId: 'thread-1',
      runCount: 3,
      lastRunAt: '2025-01-15T10:00:00Z',
      lastRunStatus: 'success',
      cadence: 'daily',
      purposeTags: [],
      disabled: false,
      model: 'haiku',
    };
    const msg = formatStatusMessage('cron-run2', record, false);
    expect(msg).not.toContain('Currently running');
  });

  it('shows N/A when no model or cadence', () => {
    const record: CronRunRecord = {
      cronId: 'cron-na',
      threadId: 'thread-4',
      runCount: 0,
      lastRunAt: null,
      lastRunStatus: null,
      cadence: null,
      purposeTags: [],
      disabled: false,
      model: null,
    };
    const msg = formatStatusMessage('cron-na', record);
    expect(msg).toContain('N/A');
  });
});

describe('seedTagMap', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-seed-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('copies seed file when target does not exist', async () => {
    const seedPath = path.join(tmpDir, 'seed.json');
    const targetPath = path.join(tmpDir, 'sub', 'target.json');
    await fs.writeFile(seedPath, '{"test": ""}', 'utf8');

    const seeded = await seedTagMap(seedPath, targetPath);
    expect(seeded).toBe(true);

    const content = await fs.readFile(targetPath, 'utf8');
    expect(content).toBe('{"test": ""}');
  });

  it('does not overwrite existing target', async () => {
    const seedPath = path.join(tmpDir, 'seed.json');
    const targetPath = path.join(tmpDir, 'target.json');
    await fs.writeFile(seedPath, '{"new": ""}', 'utf8');
    await fs.writeFile(targetPath, '{"existing": "123"}', 'utf8');

    const seeded = await seedTagMap(seedPath, targetPath);
    expect(seeded).toBe(false);

    const content = await fs.readFile(targetPath, 'utf8');
    expect(content).toBe('{"existing": "123"}');
  });
});

describe('ensureStatusMessage', () => {
  function makeRecord(overrides?: Partial<CronRunRecord>): CronRunRecord {
    return {
      cronId: 'cron-test1',
      threadId: 'thread-1',
      runCount: 3,
      lastRunAt: '2025-01-15T10:00:00Z',
      lastRunStatus: 'success',
      cadence: 'daily',
      purposeTags: ['monitoring'],
      disabled: false,
      model: 'haiku',
      ...overrides,
    };
  }

  function makeStats(): CronRunStats {
    return {
      upsertRecord: vi.fn(async () => makeRecord()),
      getRecord: vi.fn(() => makeRecord()),
    } as unknown as CronRunStats;
  }

  it('creates a new status message when none exists', async () => {
    const sentMsg = { id: 'new-msg-1', pin: vi.fn() };
    const thread = {
      isThread: () => true,
      send: vi.fn(async () => sentMsg),
      messages: { fetch: vi.fn() },
    };
    const client = {
      channels: {
        cache: { get: () => thread },
        fetch: vi.fn(async () => thread),
      },
    };
    const stats = makeStats();

    const result = await ensureStatusMessage(client as any, 'thread-1', 'cron-test1', makeRecord(), stats);
    expect(result).toBe('new-msg-1');
    expect(thread.send).toHaveBeenCalled();
    expect(sentMsg.pin).toHaveBeenCalled();
    expect(stats.upsertRecord).toHaveBeenCalledWith('cron-test1', 'thread-1', { statusMessageId: 'new-msg-1' });
  });

  it('edits existing status message', async () => {
    const existingMsg = { id: 'existing-msg', edit: vi.fn() };
    const thread = {
      isThread: () => true,
      send: vi.fn(),
      messages: { fetch: vi.fn(async () => existingMsg) },
    };
    const client = {
      channels: {
        cache: { get: () => thread },
        fetch: vi.fn(async () => thread),
      },
    };

    const record = makeRecord({ statusMessageId: 'existing-msg' });
    const result = await ensureStatusMessage(client as any, 'thread-1', 'cron-test1', record, makeStats());
    expect(result).toBe('existing-msg');
    expect(existingMsg.edit).toHaveBeenCalled();
    expect(thread.send).not.toHaveBeenCalled();
  });

  it('returns undefined when thread not found', async () => {
    const client = {
      channels: {
        cache: { get: () => undefined },
        fetch: vi.fn(async () => null),
      },
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await ensureStatusMessage(client as any, 'missing', 'cron-test1', makeRecord(), makeStats(), { log });
    expect(result).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it('passes running flag through to formatted content', async () => {
    const sentMsg = { id: 'run-msg-1', pin: vi.fn() };
    const thread = {
      isThread: () => true,
      send: vi.fn(async () => sentMsg),
      messages: { fetch: vi.fn() },
    };
    const client = {
      channels: {
        cache: { get: () => thread },
        fetch: vi.fn(async () => thread),
      },
    };
    const stats = makeStats();

    await ensureStatusMessage(client as any, 'thread-1', 'cron-test1', makeRecord(), stats, { running: true });
    expect(thread.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Currently running') }),
    );
  });

  it('creates new message when existing statusMessageId is stale', async () => {
    const sentMsg = { id: 'new-msg-2', pin: vi.fn() };
    const thread = {
      isThread: () => true,
      send: vi.fn(async () => sentMsg),
      messages: { fetch: vi.fn(async () => { throw new Error('Unknown Message'); }) },
    };
    const client = {
      channels: {
        cache: { get: () => thread },
        fetch: vi.fn(async () => thread),
      },
    };

    const record = makeRecord({ statusMessageId: 'deleted-msg' });
    const stats = makeStats();
    const result = await ensureStatusMessage(client as any, 'thread-1', 'cron-test1', record, stats);
    expect(result).toBe('new-msg-2');
    expect(thread.send).toHaveBeenCalled();
  });
});

describe('resolveForumChannel', () => {
  it('returns forum from cache', async () => {
    const forum = { id: 'forum-1', type: 15 };
    const client = {
      channels: {
        cache: { get: (id: string) => id === 'forum-1' ? forum : undefined },
        fetch: vi.fn(),
      },
    };
    const result = await resolveForumChannel(client as any, 'forum-1');
    expect(result).toBe(forum);
  });

  it('returns null for non-forum channel', async () => {
    const textChannel = { id: 'text-1', type: 0 };
    const client = {
      channels: {
        cache: { get: () => textChannel },
        fetch: vi.fn(async () => textChannel),
      },
    };
    const result = await resolveForumChannel(client as any, 'text-1');
    expect(result).toBeNull();
  });

  it('returns null when channel not found', async () => {
    const client = {
      channels: {
        cache: { get: () => undefined },
        fetch: vi.fn(async () => null),
      },
    };
    const result = await resolveForumChannel(client as any, 'missing');
    expect(result).toBeNull();
  });
});
