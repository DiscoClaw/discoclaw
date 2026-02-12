import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./bead-sync.js', () => ({
  runBeadSync: vi.fn(async () => ({
    threadsCreated: 0,
    emojisUpdated: 0,
    starterMessagesUpdated: 0,
    threadsArchived: 0,
    statusesUpdated: 0,
    warnings: 0,
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
      return { threadsCreated: 1, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, warnings: 0 };
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
