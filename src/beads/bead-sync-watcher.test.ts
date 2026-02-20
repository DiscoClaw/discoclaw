import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { startBeadSyncWatcher } from './bead-sync-watcher.js';

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

function makeStore() {
  return new EventEmitter() as any;
}

describe('startBeadSyncWatcher', () => {
  it('triggers sync on store created event', async () => {
    const coordinator = makeCoordinator();
    const store = makeStore();
    const handle = startBeadSyncWatcher({ coordinator, store });

    store.emit('created', {});
    await Promise.resolve();

    expect(coordinator.sync).toHaveBeenCalledOnce();
    expect(coordinator.sync).toHaveBeenCalledWith();

    handle.stop();
  });

  it('triggers sync on store updated event', async () => {
    const coordinator = makeCoordinator();
    const store = makeStore();
    const handle = startBeadSyncWatcher({ coordinator, store });

    store.emit('updated', {}, {});
    await Promise.resolve();

    expect(coordinator.sync).toHaveBeenCalledOnce();

    handle.stop();
  });

  it('triggers sync on store closed event', async () => {
    const coordinator = makeCoordinator();
    const store = makeStore();
    const handle = startBeadSyncWatcher({ coordinator, store });

    store.emit('closed', {});
    await Promise.resolve();

    expect(coordinator.sync).toHaveBeenCalledOnce();

    handle.stop();
  });

  it('triggers sync on store labeled event', async () => {
    const coordinator = makeCoordinator();
    const store = makeStore();
    const handle = startBeadSyncWatcher({ coordinator, store });

    store.emit('labeled', {}, 'some-label');
    await Promise.resolve();

    expect(coordinator.sync).toHaveBeenCalledOnce();

    handle.stop();
  });

  it('no sync fires after stop()', async () => {
    const coordinator = makeCoordinator();
    const store = makeStore();
    const handle = startBeadSyncWatcher({ coordinator, store });

    handle.stop();

    store.emit('created', {});
    await Promise.resolve();

    expect(coordinator.sync).not.toHaveBeenCalled();
  });

  it('multiple events each trigger a sync call (coordinator coalesces)', async () => {
    const coordinator = makeCoordinator();
    const store = makeStore();
    const handle = startBeadSyncWatcher({ coordinator, store });

    store.emit('created', {});
    store.emit('updated', {}, {});
    store.emit('closed', {});
    await Promise.resolve();

    // Each event fires a sync; the coordinator's concurrency guard coalesces them.
    expect(coordinator.sync).toHaveBeenCalledTimes(3);

    handle.stop();
  });

  it('sync failure is caught and logged without throwing', async () => {
    const coordinator = {
      sync: vi.fn().mockRejectedValue(new Error('network error')),
    } as any;
    const store = makeStore();
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const handle = startBeadSyncWatcher({ coordinator, store, log });

    store.emit('created', {});

    // Flush the microtask queue so the catch handler runs.
    await new Promise((r) => setTimeout(r, 0));

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'tasks:watcher sync failed',
    );

    handle.stop();
  });
});
