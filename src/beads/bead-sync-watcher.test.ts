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

vi.mock('./discord-sync.js', () => ({
  reloadTagMapInPlace: vi.fn(async () => 2),
}));

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { startBeadSyncWatcher } from './bead-sync-watcher.js';
import { reloadTagMapInPlace } from './discord-sync.js';

function makeCoordinator() {
  return {
    sync: vi.fn(async () => ({
      threadsCreated: 0,
      emojisUpdated: 0,
      starterMessagesUpdated: 0,
      threadsArchived: 0,
      statusesUpdated: 0,
      tagsUpdated: 0,
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

// ---------------------------------------------------------------------------
// Tag-map watcher tests
// ---------------------------------------------------------------------------

describe('startBeadSyncWatcher tag-map watching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    (fs as any)._watchers.length = 0;
    // Reset to default mock behavior (clearAllMocks doesn't undo mockImplementation)
    (fsp.access as any).mockImplementation(async () => {});
    (fsp.stat as any).mockImplementation(async () => ({ mtimeMs: 1000 }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tag-map change triggers debounced reloadTagMapInPlace, not coordinator.sync', async () => {
    const coordinator = makeCoordinator();
    const tagMap = { bug: '111' };
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
      tagMapPath: '/config/tag-map.json',
      tagMap,
    });

    await vi.advanceTimersByTimeAsync(0);

    // Two watchers: .beads/ dir + tag-map parent dir
    expect((fs as any)._watchers.length).toBe(2);

    // Find the tag-map watcher (second one, watching /config)
    const tagMapWatcher = (fs as any)._watchers[1];
    tagMapWatcher._cb('change', 'tag-map.json');

    // Before debounce fires, no reload yet
    expect(reloadTagMapInPlace).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(150);

    expect(reloadTagMapInPlace).toHaveBeenCalledWith('/config/tag-map.json', tagMap);
    // No sync triggered by tag-map change
    expect(coordinator.sync).not.toHaveBeenCalled();

    handle.stop();
  });

  it('tag-map reload failure preserves existing map (no crash)', async () => {
    (reloadTagMapInPlace as any).mockRejectedValueOnce(new Error('bad json'));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const coordinator = makeCoordinator();
    const tagMap = { existing: '999' };
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
      tagMapPath: '/config/tag-map.json',
      tagMap,
      log,
    });

    await vi.advanceTimersByTimeAsync(0);

    const tagMapWatcher = (fs as any)._watchers[1];
    tagMapWatcher._cb('change', 'tag-map.json');

    await vi.advanceTimersByTimeAsync(150);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), tagMapPath: '/config/tag-map.json' }),
      'beads:tag-map watcher reload failed; using cached map',
    );

    handle.stop();
  });

  it('uses parent directory watch (not direct file watch)', async () => {
    const coordinator = makeCoordinator();
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
      tagMapPath: '/config/tag-map.json',
      tagMap: { bug: '111' },
    });

    await vi.advanceTimersByTimeAsync(0);

    // fs.watch should be called with the parent directory '/config'
    const watchCalls = (fs.watch as any).mock.calls;
    expect(watchCalls.some((c: any[]) => c[0] === '/config')).toBe(true);

    handle.stop();
  });

  it('no tag-map watcher when tagMapPath not provided', async () => {
    const coordinator = makeCoordinator();
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
      // No tagMapPath
    });

    await vi.advanceTimersByTimeAsync(0);

    // Only one watcher for .beads/ dir
    expect((fs as any)._watchers.length).toBe(1);

    handle.stop();
  });

  it('tag-map polling fallback detects mtime changes', async () => {
    let currentMtime = 1000;
    (fsp.stat as any).mockImplementation(async () => ({ mtimeMs: currentMtime }));

    const coordinator = makeCoordinator();
    const tagMap = { bug: '111' };
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
      pollFallbackMs: 500,
      tagMapPath: '/config/tag-map.json',
      tagMap,
    });

    await vi.advanceTimersByTimeAsync(0);

    // Change mtime
    currentMtime = 2000;

    // Advance past poll interval
    await vi.advanceTimersByTimeAsync(600);

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(200);

    expect(reloadTagMapInPlace).toHaveBeenCalledWith('/config/tag-map.json', tagMap);

    handle.stop();
  });

  it('tag-map watching starts even when .beads/ directory is missing', async () => {
    let accessCallCount = 0;
    (fsp.access as any).mockImplementation(async (p: string) => {
      accessCallCount++;
      // .beads dir doesn't exist, but tag-map dir does
      if (p.includes('.beads')) throw new Error('ENOENT');
    });

    const coordinator = makeCoordinator();
    const tagMap = { bug: '111' };
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
      tagMapPath: '/config/tag-map.json',
      tagMap,
    });

    await vi.advanceTimersByTimeAsync(0);

    // Only tag-map watcher should be created (beads dir missing)
    expect((fs as any)._watchers.length).toBe(1);

    // Verify tag-map watcher works
    const tagMapWatcher = (fs as any)._watchers[0];
    tagMapWatcher._cb('change', 'tag-map.json');
    await vi.advanceTimersByTimeAsync(150);

    expect(reloadTagMapInPlace).toHaveBeenCalled();
    // No sync attempted (beads dir missing, no coordinator.sync call)
    expect(coordinator.sync).not.toHaveBeenCalled();

    handle.stop();
  });

  it('tag-map dir polling starts when tagMapDir is missing at startup', async () => {
    let accessCallCount = 0;
    (fsp.access as any).mockImplementation(async (p: string) => {
      accessCallCount++;
      // Both dirs missing on first call; tag-map dir appears after poll
      if (p.includes('.beads')) throw new Error('ENOENT');
      if (p === '/config' && accessCallCount <= 2) throw new Error('ENOENT');
    });

    const coordinator = makeCoordinator();
    const tagMap = { bug: '111' };
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
      tagMapPath: '/config/tag-map.json',
      tagMap,
    });

    await vi.advanceTimersByTimeAsync(0);

    // No watchers yet (both dirs missing)
    expect((fs as any)._watchers.length).toBe(0);

    // Advance past DIR_POLL_MS to trigger tag-map dir poll
    await vi.advanceTimersByTimeAsync(30_000);

    // Tag-map dir appeared — watcher should now be created
    expect((fs as any)._watchers.length).toBe(1);

    handle.stop();
  });

  it('simultaneous .beads/ + tag-map events: both callbacks fire', async () => {
    const coordinator = makeCoordinator();
    const tagMap = { bug: '111' };
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
      tagMapPath: '/config/tag-map.json',
      tagMap,
    });

    await vi.advanceTimersByTimeAsync(0);

    const beadsWatcher = (fs as any)._watchers[0];
    const tagMapWatcher = (fs as any)._watchers[1];

    // Fire both events simultaneously
    beadsWatcher._cb('change', 'last-touched');
    tagMapWatcher._cb('change', 'tag-map.json');

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(150);

    // Both should fire
    expect(coordinator.sync).toHaveBeenCalledOnce();
    expect(reloadTagMapInPlace).toHaveBeenCalledOnce();

    handle.stop();
  });

  it('partial config (tagMapPath without tagMap): logs warning, no watcher', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const coordinator = makeCoordinator();
    const handle = startBeadSyncWatcher({
      coordinator,
      beadsCwd: '/tmp',
      debounceMs: 100,
      tagMapPath: '/config/tag-map.json',
      // No tagMap provided
      log,
    });

    await vi.advanceTimersByTimeAsync(0);

    // Only .beads/ watcher, no tag-map watcher
    expect((fs as any)._watchers.length).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      'beads:tag-map watcher: tagMapPath provided without tagMap; skipping tag-map watching',
    );

    handle.stop();
  });
});
