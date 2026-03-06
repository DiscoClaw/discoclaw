import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { ProcessPool } from './process-pool.js';
import type { LongRunningProcessOpts } from './long-running-process.js';

function createMockSubprocess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = { write: vi.fn(), end: vi.fn() };
  let resolvePromise: (val: any) => void;
  const promise = new Promise<any>((res) => {
    resolvePromise = res;
  });
  const proc: any = Object.assign(promise, {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: Math.floor(Math.random() * 100000),
  });
  return { proc, stdout, stderr, stdin, resolve: resolvePromise! };
}

const baseProcessOpts: LongRunningProcessOpts = {
  claudeBin: 'claude',
  model: 'opus',
  cwd: '/tmp',
  dangerouslySkipPermissions: true,
  hangTimeoutMs: 60000,
  idleTimeoutMs: 300000,
};

beforeEach(() => {
  vi.useFakeTimers();
  (execa as any).mockReset?.();
  (execa as any).mockImplementation(() => createMockSubprocess().proc);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProcessPool', () => {
  it('getOrSpawn creates a new process for a new session key', () => {
    const pool = new ProcessPool({ maxProcesses: 3 });
    const proc = pool.getOrSpawn('session-1', baseProcessOpts);

    expect(proc).not.toBeNull();
    expect(proc!.isAlive).toBe(true);
    expect(pool.size).toBe(1);
  });

  it('getOrSpawn returns existing process for same session key', () => {
    const pool = new ProcessPool({ maxProcesses: 3 });
    const proc1 = pool.getOrSpawn('session-1', baseProcessOpts);
    const proc2 = pool.getOrSpawn('session-1', baseProcessOpts);

    expect(proc1).toBe(proc2);
    expect(pool.size).toBe(1);
    // Only one execa call
    expect((execa as any).mock.calls).toHaveLength(1);
  });

  it('respawns when envOverrides change for the same session key', () => {
    const pool = new ProcessPool({ maxProcesses: 3 });
    const proc1 = pool.getOrSpawn('session-1', {
      ...baseProcessOpts,
      envOverrides: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' },
    });
    const proc2 = pool.getOrSpawn('session-1', {
      ...baseProcessOpts,
      envOverrides: { CLAUDE_CODE_EFFORT_LEVEL: 'high' },
    });

    expect(proc1).not.toBeNull();
    expect(proc2).not.toBeNull();
    expect(proc2).not.toBe(proc1);
    expect(proc1!.state).toBe('dead');
    expect(proc2!.isAlive).toBe(true);
    expect((execa as any).mock.calls).toHaveLength(2);
  });

  it('getOrSpawn creates separate processes for different session keys', () => {
    const pool = new ProcessPool({ maxProcesses: 3 });
    const proc1 = pool.getOrSpawn('session-1', baseProcessOpts);
    const proc2 = pool.getOrSpawn('session-2', baseProcessOpts);

    expect(proc1).not.toBe(proc2);
    expect(pool.size).toBe(2);
  });

  it('evicts oldest idle process when at capacity', () => {
    const pool = new ProcessPool({ maxProcesses: 2 });
    const proc1 = pool.getOrSpawn('session-1', baseProcessOpts);
    pool.getOrSpawn('session-2', baseProcessOpts);
    expect(pool.size).toBe(2);

    // Adding a third should evict the first (oldest idle)
    pool.getOrSpawn('session-3', baseProcessOpts);
    expect(pool.size).toBe(2);
    expect(proc1!.state).toBe('dead');
  });

  it('touching a session makes it most-recently-used (true LRU)', () => {
    const pool = new ProcessPool({ maxProcesses: 2 });
    const proc1 = pool.getOrSpawn('session-1', baseProcessOpts);
    const proc2 = pool.getOrSpawn('session-2', baseProcessOpts);
    expect(pool.size).toBe(2);

    // Touch session-1 so session-2 becomes the LRU entry.
    const proc1b = pool.getOrSpawn('session-1', baseProcessOpts);
    expect(proc1b).toBe(proc1);

    // Adding a third should evict session-2 (LRU).
    pool.getOrSpawn('session-3', baseProcessOpts);
    expect(pool.size).toBe(2);
    expect(proc2!.state).toBe('dead');
    expect(proc1!.state).not.toBe('dead');
  });

  it('does not evict busy processes; returns null when at capacity with no idle', async () => {
    const pool = new ProcessPool({ maxProcesses: 2 });
    const proc1 = pool.getOrSpawn('session-1', { ...baseProcessOpts, hangTimeoutMs: 60_000 });
    const proc2 = pool.getOrSpawn('session-2', { ...baseProcessOpts, hangTimeoutMs: 60_000 });
    expect(proc1).not.toBeNull();
    expect(proc2).not.toBeNull();

    const consume1 = (async () => {
      for await (const _evt of proc1!.sendTurn('t1')) {
        // drain until killAll unblocks
      }
    })();
    const consume2 = (async () => {
      for await (const _evt of proc2!.sendTurn('t2')) {
        // drain until killAll unblocks
      }
    })();

    expect(proc1!.state).toBe('busy');
    expect(proc2!.state).toBe('busy');

    const proc3 = pool.getOrSpawn('session-3', baseProcessOpts);
    expect(proc3).toBeNull();
    expect(pool.size).toBe(2);
    expect(proc1!.state).toBe('busy');
    expect(proc2!.state).toBe('busy');

    pool.killAll();
    await Promise.all([consume1, consume2]);
  });

  it('remove kills and deletes a specific process', () => {
    const pool = new ProcessPool({ maxProcesses: 3 });
    const proc = pool.getOrSpawn('session-1', baseProcessOpts);
    expect(pool.size).toBe(1);

    pool.remove('session-1');
    expect(pool.size).toBe(0);
    expect(proc!.state).toBe('dead');
  });

  it('remove is a no-op for unknown session key', () => {
    const pool = new ProcessPool({ maxProcesses: 3 });
    pool.getOrSpawn('session-1', baseProcessOpts);

    pool.remove('nonexistent');
    expect(pool.size).toBe(1);
  });

  it('killAll kills all processes and empties the pool', () => {
    const pool = new ProcessPool({ maxProcesses: 5 });
    const proc1 = pool.getOrSpawn('session-1', baseProcessOpts);
    const proc2 = pool.getOrSpawn('session-2', baseProcessOpts);
    const proc3 = pool.getOrSpawn('session-3', baseProcessOpts);

    pool.killAll();
    expect(pool.size).toBe(0);
    expect(proc1!.state).toBe('dead');
    expect(proc2!.state).toBe('dead');
    expect(proc3!.state).toBe('dead');
  });

  it('getOrSpawn returns null after killAll (shutdown guard)', () => {
    const pool = new ProcessPool({ maxProcesses: 3 });
    pool.getOrSpawn('session-1', baseProcessOpts);
    expect(pool.size).toBe(1);

    pool.killAll();
    expect(pool.size).toBe(0);

    const result = pool.getOrSpawn('session-2', baseProcessOpts);
    expect(result).toBeNull();
    expect(pool.size).toBe(0);
  });

  it('replaces dead process on getOrSpawn', () => {
    const pool = new ProcessPool({ maxProcesses: 3 });
    const proc1 = pool.getOrSpawn('session-1', baseProcessOpts);
    proc1!.kill(); // Mark as dead

    const proc2 = pool.getOrSpawn('session-1', baseProcessOpts);
    expect(proc2).not.toBe(proc1);
    expect(proc2!.isAlive).toBe(true);
  });
});
