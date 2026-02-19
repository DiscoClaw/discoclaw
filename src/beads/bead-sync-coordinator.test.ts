import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./bead-sync.js', () => ({
  runBeadSync: vi.fn(async () => ({
    threadsCreated: 0,
    emojisUpdated: 0,
    starterMessagesUpdated: 0,
    threadsArchived: 0,
    statusesUpdated: 0,
    tagsUpdated: 0,
    warnings: 0,
    closesDeferred: 0,
  })),
}));

vi.mock('./bead-thread-cache.js', () => ({
  beadThreadCache: { invalidate: vi.fn() },
}));

vi.mock('./discord-sync.js', () => ({
  reloadTagMapInPlace: vi.fn(async () => 2),
}));

import { BeadSyncCoordinator } from './bead-sync-coordinator.js';
import { reloadTagMapInPlace } from './discord-sync.js';

function makeOpts(): any {
  return {
    client: {},
    guild: {},
    forumId: 'forum-1',
    tagMap: {},
    beadsCwd: '/tmp',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('BeadSyncCoordinator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls runBeadSync and returns result', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    const coord = new BeadSyncCoordinator(makeOpts());
    const result = await coord.sync();

    expect(runBeadSync).toHaveBeenCalledOnce();
    expect(result).toEqual(expect.objectContaining({ threadsCreated: 0 }));
  });

  it('invalidates cache after sync', async () => {
    const { beadThreadCache } = await import('./bead-thread-cache.js');
    const coord = new BeadSyncCoordinator(makeOpts());
    await coord.sync();

    expect(beadThreadCache.invalidate).toHaveBeenCalledOnce();
  });

  it('passes statusPoster through to runBeadSync', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    const statusPoster = { beadSyncComplete: vi.fn() } as any;
    const coord = new BeadSyncCoordinator(makeOpts());
    await coord.sync(statusPoster);

    expect(runBeadSync).toHaveBeenCalledWith(
      expect.objectContaining({ statusPoster }),
    );
  });

  it('omits statusPoster when not provided', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    const coord = new BeadSyncCoordinator(makeOpts());
    await coord.sync();

    expect(runBeadSync).toHaveBeenCalledWith(
      expect.objectContaining({ statusPoster: undefined }),
    );
  });

  it('returns null for concurrent call and triggers follow-up', async () => {
    const { runBeadSync } = await import('./bead-sync.js');

    // Make the first sync take a while
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
    (runBeadSync as any).mockImplementationOnce(async () => {
      await firstPromise;
      return { threadsCreated: 1, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0 };
    });

    const coord = new BeadSyncCoordinator(makeOpts());

    // Start first sync (will block)
    const first = coord.sync();

    // Second call while first is running should return null
    const second = await coord.sync();
    expect(second).toBeNull();

    // Complete the first sync
    resolveFirst();
    const firstResult = await first;
    expect(firstResult).toEqual(expect.objectContaining({ threadsCreated: 1 }));

    // Wait a tick for the fire-and-forget follow-up to start
    await new Promise((r) => setTimeout(r, 10));

    // runBeadSync should have been called at least twice (first + follow-up)
    expect((runBeadSync as any).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('propagates runBeadSync errors and remains usable', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    const { beadThreadCache } = await import('./bead-thread-cache.js');

    (runBeadSync as any).mockRejectedValueOnce(new Error('Discord API down'));

    const coord = new BeadSyncCoordinator(makeOpts());

    // First call should throw
    await expect(coord.sync()).rejects.toThrow('Discord API down');

    // Cache should not be invalidated on failure
    expect(beadThreadCache.invalidate).not.toHaveBeenCalled();

    // Coordinator should still be usable for subsequent calls
    const result = await coord.sync();
    expect(result).toEqual(expect.objectContaining({ threadsCreated: 0 }));
    expect(beadThreadCache.invalidate).toHaveBeenCalledOnce();
  });

  it('follow-up uses the coalesced caller statusPoster, not the running one', async () => {
    const { runBeadSync } = await import('./bead-sync.js');

    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
    (runBeadSync as any).mockImplementationOnce(async () => {
      await firstPromise;
      return { threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, warnings: 0 };
    });

    const coord = new BeadSyncCoordinator(makeOpts());
    const statusPoster = { beadSyncComplete: vi.fn() } as any;

    // Watcher triggers sync without statusPoster
    const first = coord.sync();

    // User action triggers sync with statusPoster — coalesced
    const second = await coord.sync(statusPoster);
    expect(second).toBeNull();

    // Complete the first sync
    resolveFirst();
    await first;

    // Wait for fire-and-forget follow-up
    await new Promise((r) => setTimeout(r, 10));

    // The follow-up (second call to runBeadSync) should have the user's statusPoster
    const followUpCall = (runBeadSync as any).mock.calls[1];
    expect(followUpCall[0].statusPoster).toBe(statusPoster);
  });

  it('logs warning when follow-up sync fails', async () => {
    const { runBeadSync } = await import('./bead-sync.js');

    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
    (runBeadSync as any)
      .mockImplementationOnce(async () => {
        await firstPromise;
        return { threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, warnings: 0 };
      })
      .mockRejectedValueOnce(new Error('follow-up boom'));

    const opts = makeOpts();
    const coord = new BeadSyncCoordinator(opts);

    const first = coord.sync();
    await coord.sync(); // coalesce

    resolveFirst();
    await first;

    // Wait for follow-up to fail and log
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'beads:coordinator follow-up sync failed',
    );
  });

  it('reloads tag map before runBeadSync when tagMapPath is set', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    (reloadTagMapInPlace as any).mockClear();

    const opts = makeOpts();
    opts.tagMapPath = '/tmp/tag-map.json';
    opts.tagMap = { bug: '111' };

    const coord = new BeadSyncCoordinator(opts);
    await coord.sync();

    expect(reloadTagMapInPlace).toHaveBeenCalledWith('/tmp/tag-map.json', opts.tagMap);
    // reloadTagMapInPlace called before runBeadSync
    const reloadOrder = (reloadTagMapInPlace as any).mock.invocationCallOrder[0];
    const syncOrder = (runBeadSync as any).mock.invocationCallOrder[0];
    expect(reloadOrder).toBeLessThan(syncOrder);
  });

  it('preserves existing map and continues sync when tag-map reload fails', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    (reloadTagMapInPlace as any).mockRejectedValueOnce(new Error('bad json'));

    const opts = makeOpts();
    opts.tagMapPath = '/tmp/tag-map.json';
    opts.tagMap = { bug: '111' };

    const coord = new BeadSyncCoordinator(opts);
    const result = await coord.sync();

    // Sync still runs despite reload failure
    expect(result).toEqual(expect.objectContaining({ threadsCreated: 0 }));
    expect(runBeadSync).toHaveBeenCalled();
    expect(opts.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), tagMapPath: '/tmp/tag-map.json' }),
      'beads:tag-map reload failed; using cached map',
    );
  });

  it('does not attempt reload when tagMapPath is not set', async () => {
    (reloadTagMapInPlace as any).mockClear();

    const opts = makeOpts();
    // No tagMapPath set
    const coord = new BeadSyncCoordinator(opts);
    await coord.sync();

    expect(reloadTagMapInPlace).not.toHaveBeenCalled();
  });

  it('passes a tagMap snapshot to runBeadSync', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    (reloadTagMapInPlace as any).mockClear();

    const tagMap = { bug: '111' };
    const opts = makeOpts();
    opts.tagMapPath = '/tmp/tag-map.json';
    opts.tagMap = tagMap;

    const coord = new BeadSyncCoordinator(opts);
    await coord.sync();

    // runBeadSync should receive a snapshot (different object reference)
    const passedOpts = (runBeadSync as any).mock.calls[0][0];
    expect(passedOpts.tagMap).toEqual(tagMap);
    expect(passedOpts.tagMap).not.toBe(tagMap);
  });
});

describe('BeadSyncCoordinator deferred-close retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule retry when closesDeferred is 0', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    const coord = new BeadSyncCoordinator(makeOpts());
    await coord.sync();

    expect(runBeadSync).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(35_000);

    // No retry — only the original call.
    expect((runBeadSync as any).mock.calls.length).toBe(1);
  });

  it('schedules a retry sync after 30s when closesDeferred > 0', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    (runBeadSync as any).mockResolvedValueOnce({
      threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0,
      threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
      closesDeferred: 1,
    });

    const coord = new BeadSyncCoordinator(makeOpts());
    await coord.sync();

    expect(runBeadSync).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);

    // Retry should have fired.
    expect((runBeadSync as any).mock.calls.length).toBe(2);
  });

  it('deferred-close retry failure is logged', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    (runBeadSync as any)
      .mockResolvedValueOnce({
        threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0,
        threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
        closesDeferred: 1,
      })
      .mockRejectedValueOnce(new Error('retry boom'));

    const opts = makeOpts();
    const coord = new BeadSyncCoordinator(opts);
    await coord.sync();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(opts.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'beads:coordinator deferred-close retry failed',
    );
  });
});

describe('BeadSyncCoordinator sync suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppressed watcher sync returns null and does not call runBeadSync', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    const coord = new BeadSyncCoordinator(makeOpts());

    coord.suppressSync(5000);
    const result = await coord.sync(undefined, 'watcher');

    expect(result).toBeNull();
    expect(runBeadSync).not.toHaveBeenCalled();
  });

  it('user sync bypasses suppression', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    const coord = new BeadSyncCoordinator(makeOpts());

    coord.suppressSync(5000);
    const result = await coord.sync(undefined, 'user');

    expect(result).toEqual(expect.objectContaining({ threadsCreated: 0 }));
    expect(runBeadSync).toHaveBeenCalledOnce();
  });

  it('default source is user (bypasses suppression)', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    const coord = new BeadSyncCoordinator(makeOpts());

    coord.suppressSync(5000);
    const result = await coord.sync();

    expect(result).toEqual(expect.objectContaining({ threadsCreated: 0 }));
    expect(runBeadSync).toHaveBeenCalledOnce();
  });

  it('catch-up sync fires after suppression window expires', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    const coord = new BeadSyncCoordinator(makeOpts());

    coord.suppressSync(100);
    await coord.sync(undefined, 'watcher'); // suppressed, schedules catch-up

    expect(runBeadSync).not.toHaveBeenCalled();

    // Advance past the suppression window
    await vi.advanceTimersByTimeAsync(150);

    expect(runBeadSync).toHaveBeenCalledOnce();
  });

  it('multiple suppressed watcher syncs schedule only one catch-up', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    const coord = new BeadSyncCoordinator(makeOpts());

    coord.suppressSync(100);
    await coord.sync(undefined, 'watcher');
    await coord.sync(undefined, 'watcher');
    await coord.sync(undefined, 'watcher');

    expect(runBeadSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(150);

    // Only one catch-up sync should have fired
    expect(runBeadSync).toHaveBeenCalledOnce();
  });

  it('watcher sync runs normally after suppression expires', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    const coord = new BeadSyncCoordinator(makeOpts());

    coord.suppressSync(100);

    // Advance past suppression window
    await vi.advanceTimersByTimeAsync(150);

    const result = await coord.sync(undefined, 'watcher');
    expect(result).toEqual(expect.objectContaining({ threadsCreated: 0 }));
    expect(runBeadSync).toHaveBeenCalledOnce();
  });

  it('follow-up from watcher-coalesced sync respects suppression', async () => {
    // Regression: a running sync completing fires a follow-up. If all coalesced callers
    // were watcher-triggered, the follow-up must respect suppression — otherwise it
    // can create a duplicate thread for a bead that beadCreate is still setting up.
    const { runBeadSync } = await import('./bead-sync.js');

    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
    (runBeadSync as any).mockImplementationOnce(async () => {
      await firstPromise;
      return { threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0 };
    });

    const coord = new BeadSyncCoordinator(makeOpts());

    // Sync A starts (watcher-triggered)
    const first = coord.sync(undefined, 'watcher');

    // A watcher coalesces in while sync A is running
    const second = await coord.sync(undefined, 'watcher');
    expect(second).toBeNull();

    // beadCreate calls suppressSync before creating the bead file
    coord.suppressSync(5000);

    // Sync A completes — this fires the follow-up
    resolveFirst();
    await first;

    // Follow-up (from watcher-coalesced call) must respect suppression
    await vi.advanceTimersByTimeAsync(10);
    expect(runBeadSync).toHaveBeenCalledOnce(); // follow-up was suppressed

    // Catch-up fires after suppression window
    await vi.advanceTimersByTimeAsync(5100);
    expect((runBeadSync as any).mock.calls.length).toBe(2);
  });

  it('follow-up from user-coalesced sync bypasses suppression', async () => {
    // If a user-initiated sync coalesced in, the follow-up should bypass suppression.
    const { runBeadSync } = await import('./bead-sync.js');

    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
    (runBeadSync as any).mockImplementationOnce(async () => {
      await firstPromise;
      return { threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0 };
    });

    const coord = new BeadSyncCoordinator(makeOpts());

    const first = coord.sync(undefined, 'watcher');

    // User-initiated sync coalesces in
    const second = await coord.sync(undefined, 'user');
    expect(second).toBeNull();

    // beadCreate suppresses
    coord.suppressSync(5000);

    resolveFirst();
    await first;

    // Follow-up (user-upgraded) should bypass suppression and run immediately
    await vi.advanceTimersByTimeAsync(10);
    expect((runBeadSync as any).mock.calls.length).toBe(2);
  });

  it('catch-up sync failure is logged', async () => {
    const { runBeadSync } = await import('./bead-sync.js');
    (runBeadSync as any).mockRejectedValueOnce(new Error('catch-up boom'));

    const opts = makeOpts();
    const coord = new BeadSyncCoordinator(opts);

    coord.suppressSync(100);
    await coord.sync(undefined, 'watcher');

    await vi.advanceTimersByTimeAsync(150);

    expect(opts.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'beads:coordinator catch-up sync failed',
    );
  });
});
