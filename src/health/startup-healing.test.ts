import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  healStaleCronRecords,
  healStaleTaskThreadRefs,
  healCorruptedJsonStores,
} from './startup-healing.js';
import type { CronRunStats } from '../cron/run-stats.js';
import type { TaskStore } from '../tasks/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeMockStatsStore(jobs: Record<string, { cronId: string; threadId: string }>) {
  const store = {
    version: 3 as const,
    updatedAt: Date.now(),
    jobs: jobs as any,
  };
  return {
    getStore: () => store,
    removeByThreadId: vi.fn().mockResolvedValue(true),
  } as unknown as CronRunStats;
}

function makeMockTaskStore(
  tasks: Array<{ id: string; status: string; external_ref?: string; title: string }>,
) {
  return {
    list: vi.fn(() => tasks.filter((t) => t.status !== 'closed')),
  } as unknown as TaskStore;
}

type FetchImpl = (id: string) => Promise<unknown>;

function makeMockClient(fetchImpl?: FetchImpl) {
  return {
    channels: {
      fetch: vi.fn(fetchImpl ?? (() => Promise.resolve({ id: 'channel-1' }))),
    },
  };
}

// ---------------------------------------------------------------------------
// healStaleCronRecords — Scenario 2
// ---------------------------------------------------------------------------

describe('healStaleCronRecords', () => {
  it('removes stale record when channels.fetch returns null, and logs warning', async () => {
    const log = makeMockLog();
    const statsStore = makeMockStatsStore({
      'cron-abc': { cronId: 'cron-abc', threadId: 'thread-dead' },
    });
    const client = makeMockClient(() => Promise.resolve(null));

    await healStaleCronRecords(statsStore, client, log);

    expect(statsStore.removeByThreadId).toHaveBeenCalledWith('thread-dead');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cronId: 'cron-abc', threadId: 'thread-dead' }),
      expect.stringContaining('stale'),
    );
  });

  it('removes stale record when channels.fetch throws Discord error code 10003', async () => {
    const log = makeMockLog();
    const statsStore = makeMockStatsStore({
      'cron-abc': { cronId: 'cron-abc', threadId: 'thread-gone' },
    });
    const discordError = Object.assign(new Error('Unknown Channel'), { code: 10003 });
    const client = makeMockClient(() => Promise.reject(discordError));

    await healStaleCronRecords(statsStore, client, log);

    expect(statsStore.removeByThreadId).toHaveBeenCalledWith('thread-gone');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cronId: 'cron-abc', threadId: 'thread-gone' }),
      expect.stringContaining('stale'),
    );
  });

  it('removes stale record when channels.fetch throws with HTTP status 404', async () => {
    const log = makeMockLog();
    const statsStore = makeMockStatsStore({
      'cron-abc': { cronId: 'cron-abc', threadId: 'thread-404' },
    });
    const httpError = Object.assign(new Error('Not Found'), { status: 404 });
    const client = makeMockClient(() => Promise.reject(httpError));

    await healStaleCronRecords(statsStore, client, log);

    expect(statsStore.removeByThreadId).toHaveBeenCalledWith('thread-404');
  });

  it('skips the record and logs a fetch-error warning for non-404 network errors', async () => {
    const log = makeMockLog();
    const statsStore = makeMockStatsStore({
      'cron-abc': { cronId: 'cron-abc', threadId: 'thread-1' },
    });
    const networkError = new Error('ECONNRESET');
    const client = makeMockClient(() => Promise.reject(networkError));

    await healStaleCronRecords(statsStore, client, log);

    expect(statsStore.removeByThreadId).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cronId: 'cron-abc', threadId: 'thread-1' }),
      expect.stringContaining('fetch error'),
    );
  });

  it('preserves the live record when one record is stale and one is live', async () => {
    const log = makeMockLog();
    const statsStore = makeMockStatsStore({
      'cron-stale': { cronId: 'cron-stale', threadId: 'thread-dead' },
      'cron-live': { cronId: 'cron-live', threadId: 'thread-alive' },
    });
    const client = makeMockClient((id) =>
      id === 'thread-dead' ? Promise.resolve(null) : Promise.resolve({ id }),
    );

    await healStaleCronRecords(statsStore, client, log);

    expect(statsStore.removeByThreadId).toHaveBeenCalledTimes(1);
    expect(statsStore.removeByThreadId).toHaveBeenCalledWith('thread-dead');
    expect(statsStore.removeByThreadId).not.toHaveBeenCalledWith('thread-alive');
  });

  it('logs and continues (fail-open) when removeByThreadId throws', async () => {
    const log = makeMockLog();
    const statsStore = makeMockStatsStore({
      'cron-abc': { cronId: 'cron-abc', threadId: 'thread-dead' },
    });
    (statsStore.removeByThreadId as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('write error'),
    );
    const client = makeMockClient(() => Promise.resolve(null));

    await expect(healStaleCronRecords(statsStore, client, log)).resolves.not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cronId: 'cron-abc', threadId: 'thread-dead' }),
      expect.stringContaining('failed to remove'),
    );
  });

  it('is a no-op and does not throw when the stats store is empty', async () => {
    const log = makeMockLog();
    const statsStore = makeMockStatsStore({});
    const client = makeMockClient();

    await expect(healStaleCronRecords(statsStore, client, log)).resolves.not.toThrow();
    expect(statsStore.removeByThreadId).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('works without a log argument', async () => {
    const statsStore = makeMockStatsStore({
      'cron-abc': { cronId: 'cron-abc', threadId: 'thread-dead' },
    });
    const client = makeMockClient(() => Promise.resolve(null));

    await expect(healStaleCronRecords(statsStore, client)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// healStaleTaskThreadRefs — Scenario 3
// ---------------------------------------------------------------------------

describe('healStaleTaskThreadRefs', () => {
  it('logs a warning when the referenced thread no longer exists (Discord code 10003)', async () => {
    const log = makeMockLog();
    const store = makeMockTaskStore([
      { id: 'ws-001', status: 'open', title: 'Task 1', external_ref: 'discord:thread-gone' },
    ]);
    const discordError = Object.assign(new Error('Unknown Channel'), { code: 10003 });
    const client = makeMockClient(() => Promise.reject(discordError));

    await healStaleTaskThreadRefs(store, client, log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'ws-001', threadId: 'thread-gone' }),
      expect.stringContaining('no longer exists'),
    );
  });

  it('logs a warning when channels.fetch returns null', async () => {
    const log = makeMockLog();
    const store = makeMockTaskStore([
      { id: 'ws-001', status: 'open', title: 'Task 1', external_ref: 'discord:thread-null' },
    ]);
    const client = makeMockClient(() => Promise.resolve(null));

    await healStaleTaskThreadRefs(store, client, log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'ws-001', threadId: 'thread-null' }),
      expect.stringContaining('no longer exists'),
    );
  });

  it('does not warn when the thread exists', async () => {
    const log = makeMockLog();
    const store = makeMockTaskStore([
      { id: 'ws-001', status: 'open', title: 'Task 1', external_ref: 'discord:thread-alive' },
    ]);
    const client = makeMockClient(() => Promise.resolve({ id: 'thread-alive' }));

    await healStaleTaskThreadRefs(store, client, log);

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not modify external_ref even when the thread is gone', async () => {
    const log = makeMockLog();
    const tasks = [
      { id: 'ws-001', status: 'open', title: 'Task 1', external_ref: 'discord:thread-gone' },
    ];
    const store = makeMockTaskStore(tasks);
    const client = makeMockClient(() => Promise.resolve(null));

    await healStaleTaskThreadRefs(store, client, log);

    expect(tasks[0].external_ref).toBe('discord:thread-gone');
  });

  it('logs a fetch-error warning (not "no longer exists") for non-404 errors', async () => {
    const log = makeMockLog();
    const store = makeMockTaskStore([
      { id: 'ws-001', status: 'open', title: 'Task 1', external_ref: 'discord:thread-1' },
    ]);
    const networkError = new Error('ECONNRESET');
    const client = makeMockClient(() => Promise.reject(networkError));

    await healStaleTaskThreadRefs(store, client, log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'ws-001', threadId: 'thread-1' }),
      expect.stringContaining('fetch error'),
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('no longer exists'),
    );
  });

  it('skips tasks without external_ref', async () => {
    const log = makeMockLog();
    const store = makeMockTaskStore([
      { id: 'ws-001', status: 'open', title: 'Task 1' },
    ]);
    const client = makeMockClient();

    await healStaleTaskThreadRefs(store, client, log);

    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('skips tasks with non-discord external_ref', async () => {
    const log = makeMockLog();
    const store = makeMockTaskStore([
      { id: 'ws-001', status: 'open', title: 'Task 1', external_ref: 'github:123' },
    ]);
    const client = makeMockClient();

    await healStaleTaskThreadRefs(store, client, log);

    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not throw and logs for each missing thread when multiple tasks have gone threads', async () => {
    const log = makeMockLog();
    const store = makeMockTaskStore([
      { id: 'ws-001', status: 'open', title: 'Task 1', external_ref: 'discord:thread-a' },
      { id: 'ws-002', status: 'in_progress', title: 'Task 2', external_ref: 'discord:thread-b' },
    ]);
    const client = makeMockClient(() => Promise.resolve(null));

    await expect(healStaleTaskThreadRefs(store, client, log)).resolves.not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('works without a log argument', async () => {
    const store = makeMockTaskStore([
      { id: 'ws-001', status: 'open', title: 'Task 1', external_ref: 'discord:thread-gone' },
    ]);
    const client = makeMockClient(() => Promise.resolve(null));

    await expect(healStaleTaskThreadRefs(store, client)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// healCorruptedJsonStores — Scenario 4
// ---------------------------------------------------------------------------

describe('healCorruptedJsonStores', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-healing-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('backs up and removes a corrupted JSON file, logging label and parse error', async () => {
    const log = makeMockLog();
    const filePath = path.join(tmpDir, 'test.json');
    const badContent = '{invalid json';
    await fs.writeFile(filePath, badContent, 'utf-8');

    await healCorruptedJsonStores([{ path: filePath, label: 'test-store' }], log);

    // Original file should be removed.
    await expect(fs.access(filePath)).rejects.toThrow();

    // A backup file should exist with the original content.
    const files = await fs.readdir(tmpDir);
    const backupFiles = files.filter((f) => f.includes('.corrupt.'));
    expect(backupFiles).toHaveLength(1);
    const backupContent = await fs.readFile(path.join(tmpDir, backupFiles[0]!), 'utf-8');
    expect(backupContent).toBe(badContent);

    // Warning logged with label, path, backupPath, and parseError.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'test-store',
        path: filePath,
        backupPath: expect.stringContaining('.corrupt.'),
        parseError: expect.any(String),
      }),
      expect.stringContaining('corrupted'),
    );
  });

  it('does nothing for a valid JSON file', async () => {
    const log = makeMockLog();
    const filePath = path.join(tmpDir, 'valid.json');
    await fs.writeFile(filePath, '{"version":3,"jobs":{}}', 'utf-8');

    await healCorruptedJsonStores([{ path: filePath, label: 'valid-store' }], log);

    // File should still exist.
    await expect(fs.access(filePath)).resolves.not.toThrow();
    // No warning emitted.
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('silently skips a missing file (ENOENT is not corruption)', async () => {
    const log = makeMockLog();
    const filePath = path.join(tmpDir, 'nonexistent.json');

    await expect(
      healCorruptedJsonStores([{ path: filePath, label: 'missing-store' }], log),
    ).resolves.not.toThrow();

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('processes multiple paths, healing only the corrupt ones', async () => {
    const log = makeMockLog();
    const corruptPath = path.join(tmpDir, 'corrupt.json');
    const validPath = path.join(tmpDir, 'valid.json');
    await fs.writeFile(corruptPath, '{bad', 'utf-8');
    await fs.writeFile(validPath, '{"ok":true}', 'utf-8');

    await healCorruptedJsonStores(
      [
        { path: corruptPath, label: 'corrupt-store' },
        { path: validPath, label: 'valid-store' },
      ],
      log,
    );

    // Only the corrupt file is removed.
    await expect(fs.access(corruptPath)).rejects.toThrow();
    await expect(fs.access(validPath)).resolves.not.toThrow();

    // Only one warning.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'corrupt-store' }),
      expect.anything(),
    );
  });

  it('backup filename contains a timestamp segment', async () => {
    const log = makeMockLog();
    const filePath = path.join(tmpDir, 'ts-test.json');
    await fs.writeFile(filePath, 'not json', 'utf-8');

    await healCorruptedJsonStores([{ path: filePath, label: 'ts-store' }], log);

    const files = await fs.readdir(tmpDir);
    const backupFiles = files.filter((f) => f.startsWith('ts-test.json.corrupt.'));
    expect(backupFiles).toHaveLength(1);
    // The suffix after .corrupt. should be a non-empty timestamp string.
    const suffix = backupFiles[0]!.split('.corrupt.')[1]!;
    expect(suffix.length).toBeGreaterThan(0);
  });

  it('works without a log argument', async () => {
    const filePath = path.join(tmpDir, 'corrupt.json');
    await fs.writeFile(filePath, '{bad', 'utf-8');

    await expect(
      healCorruptedJsonStores([{ path: filePath, label: 'test' }]),
    ).resolves.not.toThrow();
  });

  it('handles an empty paths array without throwing', async () => {
    const log = makeMockLog();

    await expect(healCorruptedJsonStores([], log)).resolves.not.toThrow();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
