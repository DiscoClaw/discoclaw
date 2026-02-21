import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./task-sync-engine.js', () => {
  const runTaskSync = vi.fn(async () => ({
    threadsCreated: 0,
    emojisUpdated: 0,
    starterMessagesUpdated: 0,
    threadsArchived: 0,
    statusesUpdated: 0,
    tagsUpdated: 0,
    warnings: 0,
    closesDeferred: 0,
  }));
  return { runTaskSync };
});

vi.mock('./thread-cache.js', () => ({
  taskThreadCache: { invalidate: vi.fn() },
}));

vi.mock('./discord-sync.js', () => ({
  reloadTagMapInPlace: vi.fn(async () => 2),
}));

import { TaskSyncCoordinator } from './sync-coordinator.js';
import { reloadTagMapInPlace } from './discord-sync.js';

function makeOpts(): any {
  return {
    client: {},
    guild: {},
    forumId: 'forum-1',
    tagMap: {},
    store: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { increment: vi.fn() },
  };
}

describe('TaskSyncCoordinator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls runTaskSync and returns result', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    const opts = makeOpts();
    const coord = new TaskSyncCoordinator(opts);
    const result = await coord.sync();

    expect(runTaskSync).toHaveBeenCalledOnce();
    expect(result).toEqual(expect.objectContaining({ threadsCreated: 0 }));
  });

  it('records success metrics and transition counters', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    (runTaskSync as any).mockResolvedValueOnce({
      threadsCreated: 2,
      emojisUpdated: 3,
      starterMessagesUpdated: 4,
      threadsArchived: 5,
      statusesUpdated: 6,
      tagsUpdated: 7,
      warnings: 1,
      threadsReconciled: 8,
      orphanThreadsFound: 9,
      closesDeferred: 10,
    });

    const opts = makeOpts();
    const coord = new TaskSyncCoordinator(opts);
    await coord.sync();

    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.started');
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.succeeded');
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.duration_ms.samples');
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.transition.threads_created', 2);
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.transition.thread_names_updated', 3);
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.transition.starter_messages_updated', 4);
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.transition.threads_archived', 5);
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.transition.statuses_updated', 6);
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.transition.tags_updated', 7);
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.transition.warnings', 1);
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.transition.threads_reconciled', 8);
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.transition.orphan_threads_found', 9);
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.transition.closes_deferred', 10);
    const durationCall = (opts.metrics.increment as any).mock.calls.find(
      ([name]: [string]) => name === 'tasks.sync.duration_ms.total',
    );
    expect(durationCall).toBeTruthy();
    expect(typeof durationCall[1]).toBe('number');
  });

  it('invalidates cache after sync', async () => {
    const { taskThreadCache } = await import('./thread-cache.js');
    const opts = makeOpts();
    const coord = new TaskSyncCoordinator(opts);
    await coord.sync();

    expect(taskThreadCache.invalidate).toHaveBeenCalledOnce();
  });

  it('passes statusPoster through to runTaskSync', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    const statusPoster = { taskSyncComplete: vi.fn() } as any;
    const opts = makeOpts();
    const coord = new TaskSyncCoordinator(opts);
    await coord.sync(statusPoster);

    expect(runTaskSync).toHaveBeenCalledWith(
      expect.objectContaining({ statusPoster }),
    );
  });

  it('omits statusPoster when not provided', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    const opts = makeOpts();
    const coord = new TaskSyncCoordinator(opts);
    await coord.sync();

    expect(runTaskSync).toHaveBeenCalledWith(
      expect.objectContaining({ statusPoster: undefined }),
    );
  });

  it('returns null for concurrent call and triggers follow-up', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');

    // Make the first sync take a while
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
    (runTaskSync as any).mockImplementationOnce(async () => {
      await firstPromise;
      return { threadsCreated: 1, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0 };
    });

    const opts = makeOpts();
    const coord = new TaskSyncCoordinator(opts);

    // Start first sync (will block)
    const first = coord.sync();

    // Second call while first is running should return null
    const second = await coord.sync();
    expect(second).toBeNull();
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.coalesced');

    // Complete the first sync
    resolveFirst();
    const firstResult = await first;
    expect(firstResult).toEqual(expect.objectContaining({ threadsCreated: 1 }));

    // Wait a tick for the fire-and-forget follow-up to start
    await new Promise((r) => setTimeout(r, 10));

    // runTaskSync should have been called at least twice (first + follow-up)
    expect((runTaskSync as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.follow_up.scheduled');
  });

  it('propagates runTaskSync errors and remains usable', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    const { taskThreadCache } = await import('./thread-cache.js');

    (runTaskSync as any).mockRejectedValueOnce(new Error('Discord API down'));

    const opts = makeOpts();
    const coord = new TaskSyncCoordinator(opts);

    // First call should throw
    await expect(coord.sync()).rejects.toThrow('Discord API down');
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.failed');
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.error_class.other');
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.failure_retry.scheduled');

    // Cache should not be invalidated on failure
    expect(taskThreadCache.invalidate).not.toHaveBeenCalled();

    // Coordinator should still be usable for subsequent calls
    const result = await coord.sync();
    expect(result).toEqual(expect.objectContaining({ threadsCreated: 0 }));
    expect(taskThreadCache.invalidate).toHaveBeenCalledOnce();
  });

  it('follow-up uses the coalesced caller statusPoster, not the running one', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');

    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
    (runTaskSync as any).mockImplementationOnce(async () => {
      await firstPromise;
      return { threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, warnings: 0 };
    });

    const coord = new TaskSyncCoordinator(makeOpts());
    const statusPoster = { taskSyncComplete: vi.fn() } as any;

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

    // The follow-up (second call to runTaskSync) should have the user's statusPoster
    const followUpCall = (runTaskSync as any).mock.calls[1];
    expect(followUpCall[0].statusPoster).toBe(statusPoster);
  });

  it('logs warning when follow-up sync fails', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');

    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });
    (runTaskSync as any)
      .mockImplementationOnce(async () => {
        await firstPromise;
        return { threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, warnings: 0 };
      })
      .mockRejectedValueOnce(new Error('follow-up boom'));

    const opts = makeOpts();
    const coord = new TaskSyncCoordinator(opts);

    const first = coord.sync();
    await coord.sync(); // coalesce

    resolveFirst();
    await first;

    // Wait for follow-up to fail and log
    await new Promise((r) => setTimeout(r, 10));

    expect(opts.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'tasks:coordinator follow-up sync failed',
    );
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.follow_up.failed');
  });

  it('classifies sync failure metrics', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    (runTaskSync as any).mockRejectedValueOnce(new Error('missing permissions on thread close'));

    const opts = makeOpts();
    const coord = new TaskSyncCoordinator(opts);

    await expect(coord.sync()).rejects.toThrow('missing permissions on thread close');
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.failed');
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.error_class.discord_permissions');
  });

  it('reloads tag map before runTaskSync when tagMapPath is set', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    (reloadTagMapInPlace as any).mockClear();

    const opts = makeOpts();
    opts.tagMapPath = '/tmp/tag-map.json';
    opts.tagMap = { bug: '111' };

    const coord = new TaskSyncCoordinator(opts);
    await coord.sync();

    expect(reloadTagMapInPlace).toHaveBeenCalledWith('/tmp/tag-map.json', opts.tagMap);
    // reloadTagMapInPlace called before runTaskSync
    const reloadOrder = (reloadTagMapInPlace as any).mock.invocationCallOrder[0];
    const syncOrder = (runTaskSync as any).mock.invocationCallOrder[0];
    expect(reloadOrder).toBeLessThan(syncOrder);
  });

  it('preserves existing map and continues sync when tag-map reload fails', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    (reloadTagMapInPlace as any).mockRejectedValueOnce(new Error('bad json'));

    const opts = makeOpts();
    opts.tagMapPath = '/tmp/tag-map.json';
    opts.tagMap = { bug: '111' };

    const coord = new TaskSyncCoordinator(opts);
    const result = await coord.sync();

    // Sync still runs despite reload failure
    expect(result).toEqual(expect.objectContaining({ threadsCreated: 0 }));
    expect(runTaskSync).toHaveBeenCalled();
    expect(opts.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), tagMapPath: '/tmp/tag-map.json' }),
      'tasks:tag-map reload failed; using cached map',
    );
  });

  it('does not attempt reload when tagMapPath is not set', async () => {
    (reloadTagMapInPlace as any).mockClear();

    const opts = makeOpts();
    // No tagMapPath set
    const coord = new TaskSyncCoordinator(opts);
    await coord.sync();

    expect(reloadTagMapInPlace).not.toHaveBeenCalled();
  });

  it('passes a tagMap snapshot to runTaskSync', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    (reloadTagMapInPlace as any).mockClear();

    const tagMap = { bug: '111' };
    const opts = makeOpts();
    opts.tagMapPath = '/tmp/tag-map.json';
    opts.tagMap = tagMap;

    const coord = new TaskSyncCoordinator(opts);
    await coord.sync();

    // runTaskSync should receive a snapshot (different object reference)
    const passedOpts = (runTaskSync as any).mock.calls[0][0];
    expect(passedOpts.tagMap).toEqual(tagMap);
    expect(passedOpts.tagMap).not.toBe(tagMap);
  });
});

describe('TaskSyncCoordinator deferred-close retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule retry when closesDeferred is 0', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    const coord = new TaskSyncCoordinator(makeOpts());
    await coord.sync();

    expect(runTaskSync).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(35_000);

    // No retry — only the original call.
    expect((runTaskSync as any).mock.calls.length).toBe(1);
  });

  it('schedules a retry sync after 30s when closesDeferred > 0', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    (runTaskSync as any).mockResolvedValueOnce({
      threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0,
      threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
      closesDeferred: 1,
    });

    const opts = makeOpts();
    const coord = new TaskSyncCoordinator(opts);
    await coord.sync();
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.retry.scheduled');

    expect(runTaskSync).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);

    // Retry should have fired.
    expect((runTaskSync as any).mock.calls.length).toBe(2);
  });

  it('coalesces deferred-close retry scheduling while a retry is pending', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    (runTaskSync as any)
      .mockResolvedValueOnce({
        threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0,
        threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
        closesDeferred: 1,
      })
      .mockResolvedValueOnce({
        threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0,
        threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
        closesDeferred: 1,
      })
      .mockResolvedValueOnce({
        threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0,
        threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
        closesDeferred: 0,
      });

    const opts = makeOpts();
    opts.deferredRetryDelayMs = 1_000;
    const coord = new TaskSyncCoordinator(opts);
    await coord.sync();
    await coord.sync();

    const scheduledCalls = (opts.metrics.increment as any).mock.calls
      .filter(([name]: [string]) => name === 'tasks.sync.retry.scheduled');
    expect(scheduledCalls).toHaveLength(1);
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.retry.coalesced');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runTaskSync).toHaveBeenCalledTimes(3);
  });

  it('deferred-close retry failure is logged', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    (runTaskSync as any)
      .mockResolvedValueOnce({
        threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0,
        threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
        closesDeferred: 1,
      })
      .mockRejectedValueOnce(new Error('retry boom'));

    const opts = makeOpts();
    const coord = new TaskSyncCoordinator(opts);
    await coord.sync();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(opts.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'tasks:coordinator deferred-close retry failed',
    );
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.retry.failed');
  });
});

describe('TaskSyncCoordinator failure retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a retry after sync failure', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    (runTaskSync as any)
      .mockRejectedValueOnce(new Error('primary boom'))
      .mockResolvedValueOnce({
        threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0,
        threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
      });

    const opts = makeOpts();
    opts.failureRetryDelayMs = 1_000;
    const coord = new TaskSyncCoordinator(opts);

    await expect(coord.sync()).rejects.toThrow('primary boom');
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.failure_retry.scheduled');
    expect(runTaskSync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runTaskSync).toHaveBeenCalledTimes(2);
  });

  it('logs and increments metrics when failure retry also fails', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    (runTaskSync as any)
      .mockRejectedValueOnce(new Error('primary boom'))
      .mockRejectedValueOnce(new Error('retry boom'));

    const opts = makeOpts();
    opts.failureRetryDelayMs = 1_000;
    const coord = new TaskSyncCoordinator(opts);

    await expect(coord.sync()).rejects.toThrow('primary boom');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.failure_retry.failed');
    expect(opts.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'tasks:coordinator failure retry sync failed',
    );
  });

  it('does not schedule duplicate failure retries while one is pending', async () => {
    const { runTaskSync } = await import('./task-sync-engine.js');
    (runTaskSync as any)
      .mockRejectedValueOnce(new Error('boom 1'))
      .mockRejectedValueOnce(new Error('boom 2'))
      .mockResolvedValueOnce({
        threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0,
        threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
      });

    const opts = makeOpts();
    opts.failureRetryDelayMs = 1_000;
    const coord = new TaskSyncCoordinator(opts);

    await expect(coord.sync()).rejects.toThrow('boom 1');
    await expect(coord.sync()).rejects.toThrow('boom 2');

    const scheduledCalls = (opts.metrics.increment as any).mock.calls
      .filter(([name]: [string]) => name === 'tasks.sync.failure_retry.scheduled');
    expect(scheduledCalls).toHaveLength(1);
    expect(opts.metrics.increment).toHaveBeenCalledWith('tasks.sync.failure_retry.coalesced');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runTaskSync).toHaveBeenCalledTimes(3);
  });
});
