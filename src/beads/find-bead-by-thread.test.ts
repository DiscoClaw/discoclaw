import { describe, expect, it } from 'vitest';
import { TaskStore } from '../tasks/store.js';
import { findBeadByThreadId } from './bead-thread-cache.js';

function makeStore(externalRefs: string[]): TaskStore {
  const store = new TaskStore({ prefix: 'ws' });
  for (const externalRef of externalRefs) {
    const b = store.create({ title: 'Test' });
    store.update(b.id, { externalRef });
  }
  return store;
}

describe('findBeadByThreadId', () => {
  it('returns bead when external_ref matches as discord:<threadId>', () => {
    const store = makeStore([
      'discord:111222333444555666',
      'discord:999888777666555444',
    ]);

    const result = findBeadByThreadId('111222333444555666', store);
    expect(result?.id).toBe('ws-001');
  });

  it('returns bead when external_ref is raw numeric ID', () => {
    const store = makeStore(['111222333444555666']);

    const result = findBeadByThreadId('111222333444555666', store);
    expect(result?.id).toBe('ws-001');
  });

  it('returns null when no match', () => {
    const store = makeStore(['discord:999888777666555444']);

    const result = findBeadByThreadId('111222333444555666', store);
    expect(result).toBeNull();
  });

  it('returns null when store is empty', () => {
    const store = new TaskStore();

    const result = findBeadByThreadId('111222333444555666', store);
    expect(result).toBeNull();
  });
});
