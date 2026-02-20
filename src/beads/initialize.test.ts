import { describe, expect, it, vi } from 'vitest';
import type { InitializeBeadsOpts } from './initialize.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../tasks/discord-sync.js', () => ({
  loadTagMap: vi.fn().mockResolvedValue({ bug: '111', feature: '222' }),
}));

vi.mock('../tasks/forum-guard.js', () => ({
  initTasksForumGuard: vi.fn(),
}));

vi.mock('../tasks/sync-coordinator.js', () => ({
  TaskSyncCoordinator: vi.fn().mockImplementation(() => ({
    sync: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { initTasksForumGuard } from '../tasks/forum-guard.js';
import { TaskSyncCoordinator } from '../tasks/sync-coordinator.js';
import { initializeBeadsContext, wireBeadsSync } from './initialize.js';
import { initializeTasksContext, wireTaskSync } from '../tasks/initialize.js';
import { TaskStore } from '../tasks/store.js';
import { withDirectTaskLifecycle } from '../tasks/task-lifecycle.js';

function fakeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function baseOpts(overrides: Partial<InitializeBeadsOpts> = {}): InitializeBeadsOpts {
  return {
    enabled: true,
    tasksCwd: '/tmp/beads',
    tasksForum: 'forum-123',
    tasksTagMapPath: '/tmp/tag-map.json',
    tasksSidebar: false,
    tasksAutoTag: true,
    tasksAutoTagModel: 'haiku',
    runtime: {} as any,
    log: fakeLog(),
    ...overrides,
  };
}

describe('initializeBeadsContext', () => {
  it('keeps compatibility exports aligned to canonical task initialize helpers', () => {
    expect(initializeBeadsContext).toBe(initializeTasksContext);
    expect(wireBeadsSync).toBe(wireTaskSync);
  });

  it('returns undefined with no warnings when disabled', async () => {
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({ enabled: false, log }));
    expect(result.taskCtx).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns undefined and warns when no forum resolved', async () => {
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({
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
    const result = await initializeBeadsContext(baseOpts({ log }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.forumId).toBe('forum-123');
    expect(result.taskCtx!.autoTag).toBe(true);
  });

  it('resolves forum from systemTasksForumId when tasksForum is empty', async () => {
    const result = await initializeBeadsContext(baseOpts({
      tasksForum: '',
      systemTasksForumId: 'system-forum-456',
    }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.forumId).toBe('system-forum-456');
  });

  it('sets sidebarMentionUserId when sidebar enabled with mention user', async () => {
    const log = fakeLog();
    const result = await initializeBeadsContext(baseOpts({
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
    const result = await initializeBeadsContext(baseOpts({
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
    const result = await initializeBeadsContext(baseOpts({
      tasksSidebar: false,
      tasksMentionUser: 'user-789',
      log,
    }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.sidebarMentionUserId).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('propagates tagMapPath to TaskContext', async () => {
    const result = await initializeBeadsContext(baseOpts({
      tasksTagMapPath: '/my/custom/tag-map.json',
    }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.tagMapPath).toBe('/my/custom/tag-map.json');
  });

  it('uses provided store instead of creating a new one', async () => {
    const store = new TaskStore();
    const result = await initializeBeadsContext(baseOpts({ store }));
    expect(result.taskCtx).toBeDefined();
    expect(result.taskCtx!.store).toBe(store);
  });
});

describe('wireBeadsSync', () => {
  it('wires forum guard, coordinator, and store event listeners', async () => {
    const log = fakeLog();
    const store = new TaskStore();
    const taskCtx = {
      tasksCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
      store,
      log,
    } as any;
    const client = {} as any;
    const guild = {} as any;

    const result = await wireBeadsSync({
      taskCtx,
      client,
      guild,
      guildId: 'guild-1',
      tasksCwd: '/tmp/beads',
      sidebarMentionUserId: 'user-1',
      log,
    });

    expect(initTasksForumGuard).toHaveBeenCalledWith({
      client,
      forumId: 'forum-123',
      log,
      store,
      tagMap: { bug: '111' },
    });
    expect(TaskSyncCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        guild,
        forumId: 'forum-123',
        mentionUserId: 'user-1',
      }),
    );
    // The coordinator's sync() should have been called (fire-and-forget startup sync).
    const coordinatorInstance = vi.mocked(TaskSyncCoordinator).mock.results[0]?.value;
    expect(coordinatorInstance.sync).toHaveBeenCalled();
    expect(taskCtx.syncCoordinator).toBeDefined();
    expect(result).toHaveProperty('stop');
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ tasksCwd: '/tmp/beads' }),
      'tasks:store-event watcher started',
    );
  });

  it('store events trigger coordinator sync', async () => {
    const log = fakeLog();
    const store = new TaskStore({ prefix: 'test' });
    const taskCtx = {
      tasksCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
      tagMapPath: '/tmp/tag-map.json',
      store,
      log,
    } as any;

    vi.mocked(TaskSyncCoordinator).mockClear();

    await wireBeadsSync({
      taskCtx,
      client: {} as any,
      guild: {} as any,
      guildId: 'guild-1',
      tasksCwd: '/tmp/beads',
      log,
    });

    const coordinatorInstance = vi.mocked(TaskSyncCoordinator).mock.results[0]?.value;

    // 'created' is intentionally NOT wired — beadCreate handles thread creation directly.
    const callsBeforeCreate = coordinatorInstance.sync.mock.calls.length;
    const bead = store.create({ title: 'Test task' });
    expect(coordinatorInstance.sync.mock.calls.length).toBe(callsBeforeCreate);

    // 'updated' IS wired — should trigger sync.
    const callsBeforeUpdate = coordinatorInstance.sync.mock.calls.length;
    store.update(bead.id, { title: 'Updated task' });
    expect(coordinatorInstance.sync.mock.calls.length).toBeGreaterThan(callsBeforeUpdate);
  });

  it('does not trigger coordinator sync while direct task lifecycle ownership is active', async () => {
    const log = fakeLog();
    const store = new TaskStore({ prefix: 'test' });
    const taskCtx = {
      tasksCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
      tagMapPath: '/tmp/tag-map.json',
      store,
      log,
    } as any;

    vi.mocked(TaskSyncCoordinator).mockClear();

    await wireBeadsSync({
      taskCtx,
      client: {} as any,
      guild: {} as any,
      guildId: 'guild-1',
      tasksCwd: '/tmp/beads',
      log,
    });

    const coordinatorInstance = vi.mocked(TaskSyncCoordinator).mock.results[0]?.value;
    const task = store.create({ title: 'Owned lifecycle task' });
    const callsBeforeUpdate = coordinatorInstance.sync.mock.calls.length;

    await withDirectTaskLifecycle(task.id, async () => {
      store.update(task.id, { title: 'Updated while owned' });
    });

    expect(coordinatorInstance.sync.mock.calls.length).toBe(callsBeforeUpdate);
  });

  it('stop() removes store event listeners', async () => {
    const log = fakeLog();
    const store = new TaskStore({ prefix: 'test' });
    const taskCtx = {
      tasksCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
      tagMapPath: '/tmp/tag-map.json',
      store,
      log,
    } as any;

    vi.mocked(TaskSyncCoordinator).mockClear();

    const result = await wireBeadsSync({
      taskCtx,
      client: {} as any,
      guild: {} as any,
      guildId: 'guild-1',
      tasksCwd: '/tmp/beads',
      log,
    });

    result.stop();

    const coordinatorInstance = vi.mocked(TaskSyncCoordinator).mock.results[0]?.value;
    const callsAfterStop = coordinatorInstance.sync.mock.calls.length;

    // After stop(), store mutations should NOT trigger additional syncs
    const bead = store.create({ title: 'Another task' });
    store.update(bead.id, { title: 'Modified' });
    expect(coordinatorInstance.sync.mock.calls.length).toBe(callsAfterStop);
  });

  it('skips forum guard when skipForumGuard is true', async () => {
    const log = fakeLog();
    const store = new TaskStore();
    const taskCtx = {
      tasksCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap: { bug: '111' },
      tagMapPath: '/tmp/tag-map.json',
      store,
      log,
    } as any;

    vi.mocked(initTasksForumGuard).mockClear();

    await wireBeadsSync({
      taskCtx,
      client: {} as any,
      guild: {} as any,
      guildId: 'guild-1',
      tasksCwd: '/tmp/beads',
      log,
      skipForumGuard: true,
    });

    expect(initTasksForumGuard).not.toHaveBeenCalled();
    // Coordinator should still be wired
    expect(TaskSyncCoordinator).toHaveBeenCalled();
  });

  it('propagates tagMapPath to CoordinatorOptions', async () => {
    const log = fakeLog();
    const tagMap = { bug: '111' };
    const store = new TaskStore();
    const taskCtx = {
      tasksCwd: '/tmp/beads',
      forumId: 'forum-123',
      tagMap,
      tagMapPath: '/config/tag-map.json',
      store,
      log,
    } as any;

    await wireBeadsSync({
      taskCtx,
      client: {} as any,
      guild: {} as any,
      guildId: 'guild-1',
      tasksCwd: '/tmp/beads',
      log,
    });

    expect(TaskSyncCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        tagMapPath: '/config/tag-map.json',
        tagMap,
      }),
    );
  });
});
