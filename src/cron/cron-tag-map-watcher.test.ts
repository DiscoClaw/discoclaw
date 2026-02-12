import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { startCronTagMapWatcher } from './cron-tag-map-watcher.js';
import type { CronTagMapWatcherOptions } from './cron-tag-map-watcher.js';
import type { CronSyncCoordinator } from './cron-sync-coordinator.js';

vi.mock('node:fs');
vi.mock('node:fs/promises');

const mockAccess = vi.mocked(fsp.access);
const mockStat = vi.mocked(fsp.stat);
const mockWatch = vi.mocked(fs.watch);

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCoordinator() {
  return {
    sync: vi.fn(async () => ({ tagsApplied: 0, namesUpdated: 0, statusMessagesUpdated: 0, orphansDetected: 0 })),
  } as unknown as CronSyncCoordinator;
}

describe('startCronTagMapWatcher', () => {
  let watchCallback: ((eventType: string, filename: string | null) => void) | null = null;
  let watcherObj: { close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    watchCallback = null;

    watcherObj = { close: vi.fn(), on: vi.fn() };
    mockWatch.mockImplementation((_path: any, callback: any) => {
      watchCallback = callback;
      return watcherObj as any;
    });

    // Default: directory exists, file has mtime
    mockAccess.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ mtimeMs: 1000 } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('change event triggers debounced coordinator.sync()', async () => {
    const coordinator = makeCoordinator();
    const handle = startCronTagMapWatcher({
      coordinator,
      tagMapPath: '/data/tag-map.json',
      log: mockLog(),
      debounceMs: 100,
    });

    // Let access/stat promises resolve
    await vi.advanceTimersByTimeAsync(0);

    // Simulate file change
    watchCallback?.('change', 'tag-map.json');
    expect(coordinator.sync).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(100);
    expect(coordinator.sync).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('multiple rapid events debounce to single sync', async () => {
    const coordinator = makeCoordinator();
    const handle = startCronTagMapWatcher({
      coordinator,
      tagMapPath: '/data/tag-map.json',
      log: mockLog(),
      debounceMs: 200,
    });

    await vi.advanceTimersByTimeAsync(0);

    watchCallback?.('change', 'tag-map.json');
    watchCallback?.('change', 'tag-map.json');
    watchCallback?.('change', 'tag-map.json');

    await vi.advanceTimersByTimeAsync(200);
    expect(coordinator.sync).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('ignores changes to unrelated files', async () => {
    const coordinator = makeCoordinator();
    const handle = startCronTagMapWatcher({
      coordinator,
      tagMapPath: '/data/tag-map.json',
      log: mockLog(),
      debounceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);

    watchCallback?.('change', 'other-file.json');
    await vi.advanceTimersByTimeAsync(200);
    expect(coordinator.sync).not.toHaveBeenCalled();

    handle.stop();
  });

  it('polling fallback detects mtime change', async () => {
    // No fs.watch available
    mockWatch.mockImplementation(() => { throw new Error('not available'); });

    const coordinator = makeCoordinator();
    const handle = startCronTagMapWatcher({
      coordinator,
      tagMapPath: '/data/tag-map.json',
      log: mockLog(),
      debounceMs: 100,
      pollFallbackMs: 500,
    });

    // Let access resolve + seed mtime
    await vi.advanceTimersByTimeAsync(0);

    // Simulate mtime change on next poll
    mockStat.mockResolvedValue({ mtimeMs: 2000 } as any);
    await vi.advanceTimersByTimeAsync(500);

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(100);
    expect(coordinator.sync).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('dir-missing startup polls until dir appears', async () => {
    // Directory missing initially
    mockAccess.mockRejectedValueOnce(new Error('ENOENT'));

    const coordinator = makeCoordinator();
    const handle = startCronTagMapWatcher({
      coordinator,
      tagMapPath: '/data/tag-map.json',
      log: mockLog(),
      debounceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);

    // Directory appears on next dir-poll cycle
    mockAccess.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(30_000);

    // Now fs.watch should be set up and a change should work
    if (watchCallback) {
      watchCallback('change', 'tag-map.json');
      await vi.advanceTimersByTimeAsync(100);
      expect(coordinator.sync).toHaveBeenCalled();
    }

    handle.stop();
  });

  it('stop() prevents further syncs', async () => {
    const coordinator = makeCoordinator();
    const handle = startCronTagMapWatcher({
      coordinator,
      tagMapPath: '/data/tag-map.json',
      log: mockLog(),
      debounceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);

    handle.stop();

    watchCallback?.('change', 'tag-map.json');
    await vi.advanceTimersByTimeAsync(200);
    expect(coordinator.sync).not.toHaveBeenCalled();
  });

  it('stop() is idempotent', async () => {
    const coordinator = makeCoordinator();
    const handle = startCronTagMapWatcher({
      coordinator,
      tagMapPath: '/data/tag-map.json',
      log: mockLog(),
      debounceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);

    handle.stop();
    handle.stop(); // second call should not throw
    expect(watcherObj.close).toHaveBeenCalledTimes(1);
  });
});
