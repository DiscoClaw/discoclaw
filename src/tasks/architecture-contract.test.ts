import { describe, expect, it, vi } from 'vitest';
import { TaskStore } from './store.js';
import { TASK_STATUSES, type TaskStatus } from './types.js';
import {
  TASK_ARCHITECTURE_CONTRACT,
  TASK_STORE_MUTATION_EVENT_RULES,
  isTaskStoreStatusTransitionAllowed,
} from './architecture-contract.js';
import { wireTaskStoreSyncTriggers } from './task-sync.js';
import { withDirectTaskLifecycle } from './task-lifecycle.js';

function makeStore(): TaskStore {
  return new TaskStore({ prefix: 'ws' });
}

describe('task architecture contract', () => {
  it('freezes permissive TaskStore status transitions across all statuses', () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        expect(isTaskStoreStatusTransitionAllowed(from, to)).toBe(true);
      }
    }
  });

  it('keeps stable mutation/sync ownership contract sets', () => {
    expect(TASK_ARCHITECTURE_CONTRACT.storeMutationEvents).toEqual([
      'created',
      'updated',
      'closed',
      'labeled',
    ]);
    expect(TASK_ARCHITECTURE_CONTRACT.syncTriggerEvents).toEqual([
      'updated',
      'closed',
      'labeled',
    ]);
    expect(TASK_ARCHITECTURE_CONTRACT.directThreadLifecycleActions).toEqual([
      'taskCreate',
      'taskUpdate',
      'taskClose',
    ]);
  });
});

describe('TaskStore characterization', () => {
  it('allows status transitions in both directions via update', () => {
    const store = makeStore();
    const task = store.create({ title: 'Refactor tasks subsystem' });
    const transitions: Array<[TaskStatus, TaskStatus]> = [];
    store.on('updated', (next, prev) => {
      transitions.push([prev.status, next.status]);
    });

    store.update(task.id, { status: 'closed' });
    store.update(task.id, { status: 'blocked' });
    store.update(task.id, { status: 'open' });

    expect(transitions).toEqual([
      ['open', 'closed'],
      ['closed', 'blocked'],
      ['blocked', 'open'],
    ]);
  });

  it('emits expected events for label mutations and no-op label operations', () => {
    const store = makeStore();
    const task = store.create({ title: 'Tag handling' });

    const events: string[] = [];
    store.on('labeled', () => events.push('labeled'));
    store.on('updated', () => events.push('updated'));

    store.addLabel(task.id, 'plan');
    store.addLabel(task.id, 'plan');
    store.removeLabel(task.id, 'missing');
    store.removeLabel(task.id, 'plan');

    expect(events).toEqual([
      ...TASK_STORE_MUTATION_EVENT_RULES.addLabel,
      ...TASK_STORE_MUTATION_EVENT_RULES.removeLabel,
    ]);
  });
});

describe('store-event sync trigger characterization', () => {
  it('triggers sync for updated/closed/labeled only and skips direct-owned lifecycle updates', async () => {
    const store = makeStore();
    const syncCoordinator = { sync: vi.fn(async () => null) };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const wired = wireTaskStoreSyncTriggers(
      { forumId: 'forum-1', tagMap: {}, store } as any,
      syncCoordinator as any,
      log as any,
    );

    const task = store.create({ title: 'Lifecycle owner test' });
    expect(syncCoordinator.sync).toHaveBeenCalledTimes(0);

    store.update(task.id, { title: 'Updated' });
    store.addLabel(task.id, 'autotag');
    store.close(task.id);
    expect(syncCoordinator.sync).toHaveBeenCalledTimes(3);

    await withDirectTaskLifecycle(task.id, async () => {
      store.update(task.id, { title: 'Owned update' });
    });
    expect(syncCoordinator.sync).toHaveBeenCalledTimes(3);

    wired.stop();
    store.update(task.id, { title: 'After stop' });
    expect(syncCoordinator.sync).toHaveBeenCalledTimes(3);
  });
});
