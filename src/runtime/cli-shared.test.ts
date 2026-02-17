import { describe, expect, it } from 'vitest';
import {
  STDIN_THRESHOLD,
  tryParseJsonLine,
  createEventQueue,
  SubprocessTracker,
  cliExecaEnv,
  LineBuffer,
} from './cli-shared.js';

describe('STDIN_THRESHOLD', () => {
  it('is 100KB', () => {
    expect(STDIN_THRESHOLD).toBe(100_000);
  });
});

describe('tryParseJsonLine', () => {
  it('parses valid JSON', () => {
    expect(tryParseJsonLine('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null for invalid JSON', () => {
    expect(tryParseJsonLine('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(tryParseJsonLine('')).toBeNull();
  });
});

describe('createEventQueue', () => {
  it('push + drain pattern works', async () => {
    const eq = createEventQueue();
    eq.push({ type: 'text_delta', text: 'hello' });
    eq.push({ type: 'done' });

    expect(eq.q.length).toBe(2);
    expect(eq.q.shift()!.type).toBe('text_delta');
    expect(eq.q.shift()!.type).toBe('done');
  });

  it('wait resolves when push is called', async () => {
    const eq = createEventQueue();
    let resolved = false;
    const p = eq.wait().then(() => { resolved = true; });
    expect(resolved).toBe(false);
    eq.push({ type: 'done' });
    await p;
    expect(resolved).toBe(true);
  });

  it('wake without pending wait is a no-op', () => {
    const eq = createEventQueue();
    // Should not throw.
    eq.wake();
  });
});

describe('SubprocessTracker', () => {
  it('killAll kills all tracked subprocesses', () => {
    const tracker = new SubprocessTracker();
    const killed: string[] = [];
    const mockProc = { kill: (sig: string) => { killed.push(sig); } } as any;
    tracker.add(mockProc);
    tracker.killAll();
    expect(killed).toEqual(['SIGKILL']);
  });

  it('killAll kills pools first, then subprocesses', () => {
    const tracker = new SubprocessTracker();
    const order: string[] = [];
    const mockPool = { killAll: () => { order.push('pool'); } };
    const mockProc = { kill: () => { order.push('proc'); } } as any;
    tracker.addPool(mockPool);
    tracker.add(mockProc);
    tracker.killAll();
    expect(order).toEqual(['pool', 'proc']);
  });

  it('delete removes subprocess from tracking', () => {
    const tracker = new SubprocessTracker();
    let killCount = 0;
    const mockProc = { kill: () => { killCount++; } } as any;
    tracker.add(mockProc);
    tracker.delete(mockProc);
    tracker.killAll();
    expect(killCount).toBe(0);
  });
});

describe('cliExecaEnv', () => {
  it('sets NO_COLOR, FORCE_COLOR, TERM defaults', () => {
    const env = cliExecaEnv();
    // Values are either from process.env or our defaults.
    expect(env.NO_COLOR).toBeDefined();
    expect(env.FORCE_COLOR).toBeDefined();
    expect(env.TERM).toBeDefined();
  });
});

describe('LineBuffer', () => {
  it('splits lines and preserves trailing buffer', () => {
    const lb = new LineBuffer();
    const lines = lb.feed('line1\nline2\npartial');
    expect(lines).toEqual(['line1', 'line2']);
    expect(lb.flush()).toBe('partial');
  });

  it('handles \\r\\n line endings', () => {
    const lb = new LineBuffer();
    const lines = lb.feed('a\r\nb\r\n');
    expect(lines).toEqual(['a', 'b']);
    expect(lb.flush()).toBe('');
  });

  it('accumulates across multiple feeds', () => {
    const lb = new LineBuffer();
    expect(lb.feed('hel')).toEqual([]);
    expect(lb.feed('lo\nworld\n')).toEqual(['hello', 'world']);
  });

  it('flush returns empty string when buffer is empty', () => {
    const lb = new LineBuffer();
    lb.feed('complete\n');
    expect(lb.flush()).toBe('');
  });
});
