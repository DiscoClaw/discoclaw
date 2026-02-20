import { describe, expect, it } from 'vitest';
import {
  isDirectTaskLifecycleActive,
  withDirectTaskLifecycle,
  withTaskLifecycleLock,
} from './task-lifecycle.js';

describe('task lifecycle lock', () => {
  it('serializes lifecycle work for the same task id', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withTaskLifecycleLock('ws-001', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    await Promise.resolve();

    const second = withTaskLifecycleLock('ws-001', async () => {
      events.push('second:start');
      events.push('second:end');
    });
    await Promise.resolve();

    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('tracks direct action ownership only while work is active', async () => {
    expect(isDirectTaskLifecycleActive('ws-002')).toBe(false);

    await withDirectTaskLifecycle('ws-002', async () => {
      expect(isDirectTaskLifecycleActive('ws-002')).toBe(true);
      await Promise.resolve();
      expect(isDirectTaskLifecycleActive('ws-002')).toBe(true);
    });

    expect(isDirectTaskLifecycleActive('ws-002')).toBe(false);
  });
});
