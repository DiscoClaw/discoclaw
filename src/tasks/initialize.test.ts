import { describe, expect, it, vi } from 'vitest';
import type { InitializeTasksOpts } from './initialize.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('./tag-map.js', () => ({
  loadTagMap: vi.fn().mockResolvedValue({ bug: '111', feature: '222' }),
}));

vi.mock('./sync-coordinator.js', () => ({
  TaskSyncCoordinator: vi.fn().mockImplementation(() => ({
    sync: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { TaskSyncCoordinator } from './sync-coordinator.js';
import { initializeTasksContext, wireTaskSync } from './initialize.js';
import { TaskStore } from './store.js';

function fakeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function baseOpts(overrides: Partial<InitializeTasksOpts> = {}): InitializeTasksOpts {
  return {
    enabled: true,
    tasksCwd: '/tmp/tasks',
    tasksForum: 'forum-123',
    tasksTagMapPath: '/tmp/tag-map.json',
    tasksSidebar: false,
    tasksAutoTag: true,
    tasksAutoTagModel: 'haiku',
    runtime: {} as any,
    resolveModel: (model) => model,
    log: fakeLog(),
    ...overrides,
  };
}

describe('initializeTasksContext', () => {
  it('returns undefined with no warnings when disabled', async () => {
    const log = fakeLog();
    const result = await initializeTasksContext(baseOpts({ enabled: false, log }));
    expect(result.taskCtx).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns undefined and warns when no forum resolved', async () => {
    const log = fakeLog();
    const result = await initializeTasksContext(baseOpts({
      tasksForum: '',
      systemTasksForumId: undefined,
      log,
    }));
    expect(result.taskCtx).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('no forum resolved'),
    );
  });

  it('returns TaskContext when all prerequisites met', async () => {
    const log = fakeLog();
    const result = await initializeTasksContext(baseOpts({ log }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.forumId).toBe('forum-123');
    expect(result.taskCtx!.autoTag).toBe(true);
  });

  it('resolves forum from systemTasksForumId when tasksForum is empty', async () => {
    const result = await initializeTasksContext(baseOpts({
      tasksForum: '',
      systemTasksForumId: 'system-forum-456',
    }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.forumId).toBe('system-forum-456');
  });

  it('sets sidebarMentionUserId when sidebar enabled with mention user', async () => {
    const log = fakeLog();
    const result = await initializeTasksContext(baseOpts({
      tasksSidebar: true,
      tasksMentionUser: 'user-789',
      log,
    }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.sidebarMentionUserId).toBe('user-789');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns when sidebar enabled but mention user not set', async () => {
    const log = fakeLog();
    const result = await initializeTasksContext(baseOpts({
      tasksSidebar: true,
      tasksMentionUser: undefined,
      log,
    }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.sidebarMentionUserId).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('sidebar mentions will be inactive'),
    );
  });

  it('does not set sidebarMentionUserId when sidebar disabled', async () => {
    const log = fakeLog();
    const result = await initializeTasksContext(baseOpts({
      tasksSidebar: false,
      tasksMentionUser: 'user-789',
      log,
    }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.sidebarMentionUserId).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('propagates tagMapPath to TaskContext', async () => {
    const result = await initializeTasksContext(baseOpts({
      tasksTagMapPath: '/my/custom/tag-map.json',
    }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.tagMapPath).toBe('/my/custom/tag-map.json');
  });

  it('stores sync run options on TaskContext', async () => {
    const result = await initializeTasksContext(baseOpts({
      syncRunOptions: { skipPhase5: true },
    }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.syncRunOptions).toEqual({ skipPhase5: true });
  });

  it('uses provided store instead of creating a new one', async () => {
    const store = new TaskStore();
    const result = await initializeTasksContext(baseOpts({ store }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.store).toBe(store);
  });
});

describe('wireTaskSync', () => {
  it('wires coordinator and fires startup sync', async () => {
    const log = fakeLog();
    const store = new TaskStore();
    const taskCtx = {
      tasksCwd: '/tmp/tasks',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
      sidebarMentionUserId: 'user-1',
      store,
      syncFailureRetryEnabled: false,
      syncFailureRetryDelayMs: 12_000,
      syncDeferredRetryDelayMs: 18_000,
      log,
    } as any;
    const client = {} as any;
    const guild = {} as any;

    await wireTaskSync(taskCtx, { client, guild });

    expect(TaskSyncCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        guild,
        forumId: 'forum-123',
        mentionUserId: 'user-1',
        enableFailureRetry: false,
        failureRetryDelayMs: 12_000,
        deferredRetryDelayMs: 18_000,
      }),
    );
    // The coordinator's sync() should have been called (fire-and-forget startup sync).
    const coordinatorInstance = vi.mocked(TaskSyncCoordinator).mock.results[0]?.value;
    expect(coordinatorInstance.sync).toHaveBeenCalled();
    expect(taskCtx.syncCoordinator).toBeDefined();
  });

  it('store mutations do not trigger coordinator sync beyond startup call', async () => {
    const log = fakeLog();
    const store = new TaskStore({ prefix: 'test' });
    const taskCtx = {
      tasksCwd: '/tmp/tasks',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
      tagMapPath: '/tmp/tag-map.json',
      store,
      log,
    } as any;

    vi.mocked(TaskSyncCoordinator).mockClear();

    await wireTaskSync(taskCtx, { client: {} as any, guild: {} as any });

    const coordinatorInstance = vi.mocked(TaskSyncCoordinator).mock.results[0]?.value;
    const syncCallsAfterStartup = coordinatorInstance.sync.mock.calls.length;

    // Mutate the store — store events are no longer wired, so no additional syncs
    const task = store.create({ title: 'Test task' });
    store.update(task.id, { title: 'Updated task' });
    store.update(task.id, { status: 'closed' });

    expect(coordinatorInstance.sync.mock.calls.length).toBe(syncCallsAfterStartup);
  });

  it('propagates tagMapPath to CoordinatorOptions', async () => {
    const log = fakeLog();
    const tagMap = { bug: '111' };
    const store = new TaskStore();
    const taskCtx = {
      tasksCwd: '/tmp/tasks',
      forumId: 'forum-123',
      tagMap,
      tagMapPath: '/config/tag-map.json',
      store,
      log,
    } as any;

    await wireTaskSync(taskCtx, { client: {} as any, guild: {} as any });

    expect(TaskSyncCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        tagMapPath: '/config/tag-map.json',
        tagMap,
      }),
    );
  });

  it('uses TaskContext sync retry configuration in CoordinatorOptions', async () => {
    const log = fakeLog();
    const store = new TaskStore();
    const taskCtx = {
      tasksCwd: '/tmp/tasks',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
      syncFailureRetryEnabled: false,
      syncFailureRetryDelayMs: 12_000,
      syncDeferredRetryDelayMs: 18_000,
      store,
      log,
    } as any;

    vi.mocked(TaskSyncCoordinator).mockClear();

    await wireTaskSync(taskCtx, { client: {} as any, guild: {} as any });

    expect(TaskSyncCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        enableFailureRetry: false,
        failureRetryDelayMs: 12_000,
        deferredRetryDelayMs: 18_000,
      }),
    );
  });
});
