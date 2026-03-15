import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSpawn,
  activeCount,
  listActive,
  cancelAll,
  _resetForTest,
} from './spawn-registry.js';

beforeEach(() => {
  _resetForTest();
});

describe('registerSpawn', () => {
  it('tracks a single spawn', () => {
    registerSpawn('spawn-1-task', 'task');
    expect(activeCount()).toBe(1);
  });

  it('tracks multiple spawns independently', () => {
    registerSpawn('spawn-1-alpha', 'alpha');
    registerSpawn('spawn-2-beta', 'beta');
    registerSpawn('spawn-3-gamma', 'gamma');
    expect(activeCount()).toBe(3);
  });

  it('overwrites entry when same key is re-registered', () => {
    registerSpawn('spawn-1-task', 'task-v1');
    registerSpawn('spawn-1-task', 'task-v2');
    expect(activeCount()).toBe(1);
    expect(listActive()[0]!.label).toBe('task-v2');
  });
});

describe('dispose', () => {
  it('removes the entry on dispose', () => {
    const { dispose } = registerSpawn('spawn-1-task', 'task');
    expect(activeCount()).toBe(1);
    dispose();
    expect(activeCount()).toBe(0);
  });

  it('only removes the disposed entry', () => {
    const { dispose: disposeA } = registerSpawn('spawn-1-a', 'a');
    registerSpawn('spawn-2-b', 'b');
    disposeA();
    expect(activeCount()).toBe(1);
    expect(listActive()[0]!.label).toBe('b');
  });

  it('double-dispose is a safe no-op', () => {
    const { dispose } = registerSpawn('spawn-1-task', 'task');
    dispose();
    dispose();
    expect(activeCount()).toBe(0);
  });
});

describe('listActive', () => {
  it('returns empty array when no spawns', () => {
    expect(listActive()).toEqual([]);
  });

  it('returns snapshot with key, label, and startedAt', () => {
    registerSpawn('spawn-1-task', 'task');
    const entries = listActive();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe('spawn-1-task');
    expect(entries[0]!.label).toBe('task');
    expect(entries[0]!.startedAt).toBeInstanceOf(Date);
  });

  it('returns a copy (mutations do not affect registry)', () => {
    registerSpawn('spawn-1-task', 'task');
    const snapshot = listActive();
    snapshot.pop();
    expect(activeCount()).toBe(1);
  });
});

describe('cancelAll', () => {
  it('returns 0 when no spawns are active', () => {
    expect(cancelAll()).toBe(0);
  });

  it('returns count and clears all entries', () => {
    registerSpawn('spawn-1-a', 'a');
    registerSpawn('spawn-2-b', 'b');
    registerSpawn('spawn-3-c', 'c');
    expect(cancelAll()).toBe(3);
    expect(activeCount()).toBe(0);
    expect(listActive()).toEqual([]);
  });

  it('is idempotent — second call returns 0', () => {
    registerSpawn('spawn-1-task', 'task');
    cancelAll();
    expect(cancelAll()).toBe(0);
  });
});

describe('_resetForTest', () => {
  it('clears all state', () => {
    registerSpawn('spawn-1-a', 'a');
    registerSpawn('spawn-2-b', 'b');
    _resetForTest();
    expect(activeCount()).toBe(0);
    expect(listActive()).toEqual([]);
  });
});
