import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs and fs/promises before importing the module
vi.mock('node:fs', () => {
  const watchers: any[] = [];
  return {
    default: {
      watch: vi.fn((_path: string, cb: Function) => {
        const watcher = {
          _cb: cb,
          on: vi.fn(),
          close: vi.fn(),
        };
        watchers.push(watcher);
        return watcher;
      }),
      _watchers: watchers,
    },
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    access: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ mtimeMs: 1000 })),
  },
}));

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { startBeadSyncWatcher } from './bead-sync-watcher.js';

function makeCoordinator() {
  return {
    sync: vi.fn(async () => ({
      threadsCreated: 0,
      emojisUpdated: 0,
      starterMessagesUpdated: 0,
      threadsArchived: 0,
      statusesUpdated: 0,
      warnings: 0,
    })),
  } as any;
}

describe('startBeadSyncWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    (fs as any)._watchers.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers sync on last-touched change with debounce', async () => {
    const coordinator = makeCoordinator();
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
    });

    // Let the access check resolve (starts watching)
    await vi.advanceTimersByTimeAsync(0);

    // Simulate fs.watch event for last-touched
    const watcher = (fs as any)._watchers[0];
    expect(watcher).toBeDefined();
    watcher._cb('change', 'last-touched');

    // Before debounce fires, no sync yet
    expect(coordinator.sync).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(150);

    expect(coordinator.sync).toHaveBeenCalledOnce();
    // Auto-triggered: no statusPoster
    expect(coordinator.sync).toHaveBeenCalledWith();

    handle.stop();
  });

  it('debounces multiple rapid triggers into one sync', async () => {
    const coordinator = makeCoordinator();
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 200,
    });

    await vi.advanceTimersByTimeAsync(0);

    const watcher = (fs as any)._watchers[0];

    // Rapid-fire events
    watcher._cb('change', 'last-touched');
    await vi.advanceTimersByTimeAsync(50);
    watcher._cb('change', 'last-touched');
    await vi.advanceTimersByTimeAsync(50);
    watcher._cb('change', 'last-touched');

    // Advance past debounce from last event
    await vi.advanceTimersByTimeAsync(250);

    expect(coordinator.sync).toHaveBeenCalledOnce();

    handle.stop();
  });

  it('ignores events for files other than last-touched', async () => {
    const coordinator = makeCoordinator();
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);

    const watcher = (fs as any)._watchers[0];
    watcher._cb('change', 'beads.jsonl');
    watcher._cb('change', 'index');

    await vi.advanceTimersByTimeAsync(200);

    expect(coordinator.sync).not.toHaveBeenCalled();

    handle.stop();
  });

  it('no syncs fire after stop()', async () => {
    const coordinator = makeCoordinator();
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);

    const watcher = (fs as any)._watchers[0];
    watcher._cb('change', 'last-touched');

    // Stop before debounce fires
    handle.stop();

    await vi.advanceTimersByTimeAsync(200);

    expect(coordinator.sync).not.toHaveBeenCalled();
  });

  it('polls for directory when .beads/ does not exist yet', async () => {
    // First access call fails (directory doesn't exist), then succeeds
    let accessCallCount = 0;
    (fsp.access as any).mockImplementation(async () => {
      accessCallCount++;
      if (accessCallCount <= 1) throw new Error('ENOENT');
    });

    const coordinator = makeCoordinator();
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
    });

    // First access fails — no watcher set up
    await vi.advanceTimersByTimeAsync(0);
    expect((fs as any)._watchers.length).toBe(0);

    // Advance past DIR_POLL_MS (30s) to trigger directory poll
    await vi.advanceTimersByTimeAsync(30_000);

    // Directory appeared — watcher should now be created
    expect((fs as any)._watchers.length).toBe(1);

    handle.stop();
  });

  it('polling fallback detects mtime changes', async () => {
    let currentMtime = 1000;
    (fsp.stat as any).mockImplementation(async () => ({ mtimeMs: currentMtime }));

    const coordinator = makeCoordinator();
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
      pollFallbackMs: 500,
    });

    await vi.advanceTimersByTimeAsync(0);

    // Simulate mtime change
    currentMtime = 2000;

    // Advance past poll interval
    await vi.advanceTimersByTimeAsync(600);

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(200);

    expect(coordinator.sync).toHaveBeenCalled();

    handle.stop();
  });
});
