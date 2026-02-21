import { describe, expect, it, vi } from 'vitest';
import { TaskStore } from './store.js';
import {
  ensureTaskSyncCoordinator,
  runTaskSync,
  wireTaskStoreSyncTriggers,
} from './task-sync.js';
import { withDirectTaskLifecycle } from './task-lifecycle.js';

vi.mock('./sync-coordinator.js', () => ({
  TaskSyncCoordinator: vi.fn().mockImplementation(() => ({
    sync: vi.fn(async () => ({
      threadsCreated: 0,
      emojisUpdated: 0,
      starterMessagesUpdated: 0,
      threadsArchived: 0,
      statusesUpdated: 0,
      tagsUpdated: 0,
      warnings: 0,
    })),
  })),
}));

function makeTaskCtx() {
  return {
    forumId: 'forum-1',
    tagMap: { feature: 'tag-1' },
    tagMapPath: '/tmp/tag-map.json',
    store: new TaskStore({ prefix: 'ws' }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    sidebarMentionUserId: 'user-123',
    forumCountSync: { requestUpdate: vi.fn(), stop: vi.fn() },
    syncFailureRetryEnabled: false,
    syncFailureRetryDelayMs: 12_000,
    syncDeferredRetryDelayMs: 18_000,
  };
}

function makeRunCtx() {
  return { client: {} as any, guild: {} as any };
}

describe('task-sync coordinator helpers', () => {
  it('creates and reuses coordinator on task context', async () => {
    const { TaskSyncCoordinator } = await import('./sync-coordinator.js');
    const taskCtx = makeTaskCtx();

    const first = await ensureTaskSyncCoordinator(taskCtx as any, makeRunCtx(), { skipPhase5: true });
    const second = await ensureTaskSyncCoordinator(taskCtx as any, makeRunCtx());

    expect(first).toBe(second);
    expect(TaskSyncCoordinator).toHaveBeenCalledOnce();
    expect(TaskSyncCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        client: expect.anything(),
        guild: expect.anything(),
        forumId: 'forum-1',
        tagMapPath: '/tmp/tag-map.json',
        mentionUserId: 'user-123',
        skipPhase5: true,
        enableFailureRetry: false,
        failureRetryDelayMs: 12_000,
        deferredRetryDelayMs: 18_000,
      }),
    );
  });

  it('runTaskSync forwards statusPoster to coordinator sync', async () => {
    const taskCtx = makeTaskCtx() as any;
    const statusPoster = { taskSyncComplete: vi.fn() } as any;

    const result = await runTaskSync(taskCtx, makeRunCtx(), statusPoster);
    expect(result).toEqual(expect.objectContaining({ threadsCreated: 0 }));
    expect(taskCtx.syncCoordinator.sync).toHaveBeenCalledWith(statusPoster);
  });
});

describe('wireTaskStoreSyncTriggers', () => {
  it('wires only trigger events and skips direct-lifecycle-owned updates', async () => {
    const taskCtx = makeTaskCtx();
    const syncCoordinator = { sync: vi.fn(async () => null) };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const wired = wireTaskStoreSyncTriggers(taskCtx as any, syncCoordinator as any, log as any);
    const task = taskCtx.store.create({ title: 'Test task' });

    // created does not trigger sync
    const callsAfterCreate = syncCoordinator.sync.mock.calls.length;
    expect(callsAfterCreate).toBe(0);

    // updated does trigger sync
    taskCtx.store.update(task.id, { title: 'Updated' });
    expect(syncCoordinator.sync.mock.calls.length).toBeGreaterThan(callsAfterCreate);

    const callsBeforeOwnedUpdate = syncCoordinator.sync.mock.calls.length;
    await withDirectTaskLifecycle(task.id, async () => {
      taskCtx.store.update(task.id, { title: 'Owned update' });
    });
    expect(syncCoordinator.sync.mock.calls.length).toBe(callsBeforeOwnedUpdate);

    wired.stop();
    taskCtx.store.update(task.id, { title: 'Post-stop update' });
    expect(syncCoordinator.sync.mock.calls.length).toBe(callsBeforeOwnedUpdate);
  });
});
