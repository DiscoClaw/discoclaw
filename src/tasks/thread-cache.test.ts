import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TaskStore } from './store.js';
import {
  TaskThreadCache,
  taskThreadCache,
  findTaskByThreadId,
} from './thread-cache.js';

function makeStore(tasks: Array<{ externalRef: string; title?: string }>): TaskStore {
  const store = new TaskStore({ prefix: 'ws' });
  for (const { externalRef, title } of tasks) {
    const b = store.create({ title: title ?? 'Test' });
    store.update(b.id, { externalRef });
  }
  return store;
}

describe('TaskThreadCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached task within TTL', async () => {
    const cache = new TaskThreadCache(60_000);
    const store = makeStore([{ externalRef: 'discord:thread-1' }]);
    const listSpy = vi.spyOn(store, 'list');

    const first = await cache.get('thread-1', store);
    expect(first).not.toBeNull();
    expect(listSpy).toHaveBeenCalledTimes(1);

    // Second call should use cache, not call store.list again.
    const second = await cache.get('thread-1', store);
    expect(second?.id).toBe(first?.id);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('refetches after TTL expires', async () => {
    const cache = new TaskThreadCache(0); // 0ms TTL = always expired
    const store = makeStore([{ externalRef: 'discord:thread-1' }]);
    const listSpy = vi.spyOn(store, 'list');

    const first = await cache.get('thread-1', store);
    expect(first).not.toBeNull();

    const second = await cache.get('thread-1', store);
    expect(second?.id).toBe(first?.id);
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('invalidate() clears all entries', async () => {
    const cache = new TaskThreadCache(60_000);
    const store = makeStore([
      { externalRef: 'discord:thread-1' },
      { externalRef: 'discord:thread-2' },
    ]);
    const listSpy = vi.spyOn(store, 'list');

    await cache.get('thread-1', store);
    await cache.get('thread-2', store);
    expect(listSpy).toHaveBeenCalledTimes(2);

    cache.invalidate();

    await cache.get('thread-1', store);
    expect(listSpy).toHaveBeenCalledTimes(3);
  });

  it('invalidate(threadId) clears single entry', async () => {
    const cache = new TaskThreadCache(60_000);
    const store = makeStore([
      { externalRef: 'discord:thread-1' },
      { externalRef: 'discord:thread-2' },
    ]);
    const listSpy = vi.spyOn(store, 'list');

    await cache.get('thread-1', store);
    await cache.get('thread-2', store);
    expect(listSpy).toHaveBeenCalledTimes(2);

    cache.invalidate('thread-1');

    // thread-1 should refetch, thread-2 should still be cached.
    await cache.get('thread-1', store);
    await cache.get('thread-2', store);
    expect(listSpy).toHaveBeenCalledTimes(3);
  });

  it('returns null when no task matches', async () => {
    const cache = new TaskThreadCache(60_000);
    const store = new TaskStore();

    const result = await cache.get('thread-1', store);
    expect(result).toBeNull();
  });

  it('caches null results (negative cache)', async () => {
    const cache = new TaskThreadCache(60_000);
    const store = new TaskStore();
    const listSpy = vi.spyOn(store, 'list');

    const first = await cache.get('thread-1', store);
    expect(first).toBeNull();

    const second = await cache.get('thread-1', store);
    expect(second).toBeNull();
    // Only one store.list call — the null was cached.
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('exposes module-level singleton and lookup export', () => {
    expect(taskThreadCache).toBeInstanceOf(TaskThreadCache);
    expect(typeof findTaskByThreadId).toBe('function');
  });
});
