import { describe, expect, it, vi } from 'vitest';
import {
  buildChainGraph,
  detectCycles,
  wouldCreateCycle,
  fireDownstream,
} from './chain.js';
import type { ChainFireContext } from './chain.js';

// ---------------------------------------------------------------------------
// buildChainGraph
// ---------------------------------------------------------------------------

describe('buildChainGraph', () => {
  it('builds graph from records with downstream', () => {
    const records = [
      { cronId: 'a', downstream: ['b', 'c'] },
      { cronId: 'b', downstream: ['d'] },
      { cronId: 'c' },
      { cronId: 'd' },
    ];
    const graph = buildChainGraph(records);
    expect(graph.get('a')).toEqual(['b', 'c']);
    expect(graph.get('b')).toEqual(['d']);
    expect(graph.has('c')).toBe(false);
    expect(graph.has('d')).toBe(false);
  });

  it('returns empty graph for records without downstream', () => {
    const records = [{ cronId: 'a' }, { cronId: 'b' }];
    const graph = buildChainGraph(records);
    expect(graph.size).toBe(0);
  });

  it('skips empty downstream arrays', () => {
    const records = [{ cronId: 'a', downstream: [] as string[] }];
    const graph = buildChainGraph(records);
    expect(graph.size).toBe(0);
  });

  it('copies downstream arrays (mutation-safe)', () => {
    const downstream = ['b'];
    const records = [{ cronId: 'a', downstream }];
    const graph = buildChainGraph(records);
    downstream.push('c');
    expect(graph.get('a')).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// detectCycles
// ---------------------------------------------------------------------------

describe('detectCycles', () => {
  it('returns empty for acyclic graph', () => {
    const graph = new Map([
      ['a', ['b', 'c']],
      ['b', ['d']],
      ['c', ['d']],
    ]);
    expect(detectCycles(graph)).toEqual([]);
  });

  it('detects a simple 2-node cycle', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const cycles = detectCycles(graph);
    expect(cycles.length).toBeGreaterThan(0);
    const flat = cycles.flat();
    expect(flat).toContain('a');
    expect(flat).toContain('b');
  });

  it('detects a self-loop', () => {
    const graph = new Map([['a', ['a']]]);
    const cycles = detectCycles(graph);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toEqual(['a', 'a']);
  });

  it('detects a 3-node cycle', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);
    const cycles = detectCycles(graph);
    expect(cycles.length).toBeGreaterThan(0);
    const cycle = cycles[0];
    expect(cycle[0]).toBe(cycle[cycle.length - 1]); // first === last
    expect(cycle.length).toBe(4); // a→b→c→a
  });

  it('returns empty for empty graph', () => {
    expect(detectCycles(new Map())).toEqual([]);
  });

  it('handles disconnected components, one with cycle', () => {
    const graph = new Map([
      ['a', ['b']],
      ['x', ['y']],
      ['y', ['x']],
    ]);
    const cycles = detectCycles(graph);
    expect(cycles.length).toBeGreaterThan(0);
    const flat = cycles.flat();
    expect(flat).toContain('x');
    expect(flat).toContain('y');
    // The acyclic a→b branch should not appear in any cycle.
    const cycleNodes = new Set(cycles.flatMap((c) => c));
    expect(cycleNodes.has('a')).toBe(false);
  });

  it('detects multiple independent cycles', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['a']],
      ['x', ['y']],
      ['y', ['x']],
    ]);
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(2);
  });

  it('returns cycle that starts and ends with the same node', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);
    const cycles = detectCycles(graph);
    for (const cycle of cycles) {
      expect(cycle[0]).toBe(cycle[cycle.length - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// wouldCreateCycle
// ---------------------------------------------------------------------------

describe('wouldCreateCycle', () => {
  it('returns false for safe edge in acyclic graph', () => {
    const graph = new Map([['a', ['b']]]);
    expect(wouldCreateCycle(graph, 'b', 'c')).toBe(false);
  });

  it('returns true for self-loop', () => {
    expect(wouldCreateCycle(new Map(), 'a', 'a')).toBe(true);
  });

  it('returns true when edge would close a 3-node cycle', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['c']],
    ]);
    // c→a would create a→b→c→a
    expect(wouldCreateCycle(graph, 'c', 'a')).toBe(true);
  });

  it('returns true when edge would close a 2-node cycle', () => {
    const graph = new Map([['a', ['b']]]);
    expect(wouldCreateCycle(graph, 'b', 'a')).toBe(true);
  });

  it('returns false when edge is safe in longer chain', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['c']],
    ]);
    // d→a is safe (no path from a back to d)
    expect(wouldCreateCycle(graph, 'd', 'a')).toBe(false);
  });

  it('returns false for empty graph with distinct nodes', () => {
    expect(wouldCreateCycle(new Map(), 'a', 'b')).toBe(false);
  });

  it('returns false for parallel edge (no cycle)', () => {
    const graph = new Map([
      ['a', ['b']],
      ['a', ['c']],
    ]);
    // b→c is fine
    expect(wouldCreateCycle(graph, 'b', 'c')).toBe(false);
  });

  it('detects indirect reachability through long path', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['d']],
      ['d', ['e']],
    ]);
    // e→a would create a→b→c→d→e→a
    expect(wouldCreateCycle(graph, 'e', 'a')).toBe(true);
    // e→c would create c→d→e→c
    expect(wouldCreateCycle(graph, 'e', 'c')).toBe(true);
    // e→f is safe
    expect(wouldCreateCycle(graph, 'e', 'f')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fireDownstream
// ---------------------------------------------------------------------------

describe('fireDownstream', () => {
  function makeCtx(overrides?: Partial<ChainFireContext>): ChainFireContext {
    return {
      getRecord: vi.fn().mockReturnValue(undefined),
      forwardState: vi.fn().mockResolvedValue(undefined),
      executeJob: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('fires downstream jobs in order', async () => {
    const executedIds: string[] = [];
    const ctx = makeCtx({
      getRecord: vi.fn((id: string) => ({ cronId: id, threadId: `thread-${id}` })),
      executeJob: vi.fn(async (id: string) => { executedIds.push(id); }),
    });

    const fired = await fireDownstream('a', ['b', 'c'], undefined, ctx);
    expect(fired).toEqual(['b', 'c']);
    expect(executedIds).toEqual(['b', 'c']);
  });

  it('forwards state to downstream jobs before execution', async () => {
    const calls: string[] = [];
    const state = { count: 42 };
    const ctx = makeCtx({
      getRecord: vi.fn((id: string) => ({ cronId: id, threadId: `thread-${id}` })),
      forwardState: vi.fn(async () => { calls.push('forward'); }),
      executeJob: vi.fn(async () => { calls.push('execute'); }),
    });

    await fireDownstream('a', ['b'], state, ctx);
    // Forward must happen before execute.
    expect(calls).toEqual(['forward', 'execute']);
    expect(ctx.forwardState).toHaveBeenCalledWith('b', 'thread-b', state);
  });

  it('skips downstream jobs whose records are not found', async () => {
    const ctx = makeCtx({
      getRecord: vi.fn().mockReturnValue(undefined),
    });

    const fired = await fireDownstream('a', ['missing'], undefined, ctx);
    expect(fired).toEqual([]);
    expect(ctx.executeJob).not.toHaveBeenCalled();
  });

  it('does not forward empty state', async () => {
    const ctx = makeCtx({
      getRecord: vi.fn((id: string) => ({ cronId: id, threadId: `thread-${id}` })),
    });

    await fireDownstream('a', ['b'], {}, ctx);
    expect(ctx.forwardState).not.toHaveBeenCalled();
  });

  it('does not forward undefined state', async () => {
    const ctx = makeCtx({
      getRecord: vi.fn((id: string) => ({ cronId: id, threadId: `thread-${id}` })),
    });

    await fireDownstream('a', ['b'], undefined, ctx);
    expect(ctx.forwardState).not.toHaveBeenCalled();
  });

  it('continues to next downstream if state forwarding fails', async () => {
    const ctx = makeCtx({
      getRecord: vi.fn((id: string) => ({ cronId: id, threadId: `thread-${id}` })),
      forwardState: vi.fn().mockRejectedValue(new Error('disk full')),
    });

    const fired = await fireDownstream('a', ['b'], { x: 1 }, ctx);
    expect(fired).toEqual(['b']);
    expect(ctx.executeJob).toHaveBeenCalledWith('b');
  });

  it('continues to next downstream if execution fails', async () => {
    const ctx = makeCtx({
      getRecord: vi.fn((id: string) => ({ cronId: id, threadId: `thread-${id}` })),
      executeJob: vi.fn()
        .mockRejectedValueOnce(new Error('runtime crash'))
        .mockResolvedValueOnce(undefined),
    });

    const fired = await fireDownstream('a', ['b', 'c'], undefined, ctx);
    expect(fired).toEqual(['c']);
  });

  it('returns empty array for empty downstream list', async () => {
    const ctx = makeCtx();
    const fired = await fireDownstream('a', [], undefined, ctx);
    expect(fired).toEqual([]);
    expect(ctx.getRecord).not.toHaveBeenCalled();
  });

  it('handles mixed found and missing downstream records', async () => {
    const ctx = makeCtx({
      getRecord: vi.fn((id: string) => {
        if (id === 'b') return { cronId: 'b', threadId: 'thread-b' };
        return undefined;
      }),
    });

    const fired = await fireDownstream('a', ['missing1', 'b', 'missing2'], undefined, ctx);
    expect(fired).toEqual(['b']);
    expect(ctx.executeJob).toHaveBeenCalledTimes(1);
    expect(ctx.executeJob).toHaveBeenCalledWith('b');
  });

  it('forwards state to each downstream independently', async () => {
    const state = { data: [1, 2, 3] };
    const ctx = makeCtx({
      getRecord: vi.fn((id: string) => ({ cronId: id, threadId: `thread-${id}` })),
    });

    await fireDownstream('a', ['b', 'c'], state, ctx);
    expect(ctx.forwardState).toHaveBeenCalledTimes(2);
    expect(ctx.forwardState).toHaveBeenCalledWith('b', 'thread-b', state);
    expect(ctx.forwardState).toHaveBeenCalledWith('c', 'thread-c', state);
  });
});
