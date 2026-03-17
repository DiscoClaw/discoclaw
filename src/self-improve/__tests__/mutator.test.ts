import { describe, it, expect } from 'vitest';
import { applyMutation, singleOp, MutationError } from '../mutator.js';
import type { Mutation } from '../types.js';

const SAMPLE = 'line 0\nline 1\nline 2\nline 3';

// ── insert ──────────────────────────────────────────────────────────

describe('insert', () => {
  it('inserts at the beginning', () => {
    const m = singleOp({ kind: 'insert', target: 0, content: 'new' });
    const r = applyMutation(SAMPLE, m);
    expect(r.mutated.split('\n')[0]).toBe('new');
    expect(r.mutated.split('\n')).toHaveLength(5);
  });

  it('inserts at the end', () => {
    const m = singleOp({ kind: 'insert', target: 4, content: 'tail' });
    const r = applyMutation(SAMPLE, m);
    expect(r.mutated.split('\n')[4]).toBe('tail');
  });

  it('inserts in the middle', () => {
    const m = singleOp({ kind: 'insert', target: 2, content: 'middle' });
    const r = applyMutation(SAMPLE, m);
    const lines = r.mutated.split('\n');
    expect(lines[2]).toBe('middle');
    expect(lines[3]).toBe('line 2');
  });

  it('throws if content is missing', () => {
    const m = singleOp({ kind: 'insert', target: 0 });
    expect(() => applyMutation(SAMPLE, m)).toThrow(MutationError);
  });

  it('throws if target is out of range', () => {
    const m = singleOp({ kind: 'insert', target: 10, content: 'x' });
    expect(() => applyMutation(SAMPLE, m)).toThrow('out of range');
  });
});

// ── delete ──────────────────────────────────────────────────────────

describe('delete', () => {
  it('removes a line', () => {
    const m = singleOp({ kind: 'delete', target: 1 });
    const r = applyMutation(SAMPLE, m);
    const lines = r.mutated.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(['line 0', 'line 2', 'line 3']);
  });

  it('throws for out-of-range target', () => {
    const m = singleOp({ kind: 'delete', target: 4 });
    expect(() => applyMutation(SAMPLE, m)).toThrow('out of range');
  });

  it('throws for negative target', () => {
    const m = singleOp({ kind: 'delete', target: -1 });
    expect(() => applyMutation(SAMPLE, m)).toThrow('out of range');
  });
});

// ── replace ─────────────────────────────────────────────────────────

describe('replace', () => {
  it('replaces a line in place', () => {
    const m = singleOp({ kind: 'replace', target: 2, content: 'REPLACED' });
    const r = applyMutation(SAMPLE, m);
    expect(r.mutated.split('\n')[2]).toBe('REPLACED');
    expect(r.mutated.split('\n')).toHaveLength(4);
  });

  it('throws if content is missing', () => {
    const m = singleOp({ kind: 'replace', target: 0 });
    expect(() => applyMutation(SAMPLE, m)).toThrow(MutationError);
  });
});

// ── swap ────────────────────────────────────────────────────────────

describe('swap', () => {
  it('swaps two lines', () => {
    const m = singleOp({ kind: 'swap', target: 0, swapWith: 3 });
    const r = applyMutation(SAMPLE, m);
    const lines = r.mutated.split('\n');
    expect(lines[0]).toBe('line 3');
    expect(lines[3]).toBe('line 0');
    expect(lines).toHaveLength(4);
  });

  it('throws if swapWith is missing', () => {
    const m = singleOp({ kind: 'swap', target: 0 });
    expect(() => applyMutation(SAMPLE, m)).toThrow(MutationError);
  });

  it('throws if swapWith is out of range', () => {
    const m = singleOp({ kind: 'swap', target: 0, swapWith: 10 });
    expect(() => applyMutation(SAMPLE, m)).toThrow('out of range');
  });
});

// ── Multi-op mutations ──────────────────────────────────────────────

describe('multi-op', () => {
  it('applies ops sequentially', () => {
    const mutation: Mutation = {
      ops: [
        { kind: 'delete', target: 0 },        // removes "line 0" → [line 1, line 2, line 3]
        { kind: 'insert', target: 0, content: 'new first' }, // → [new first, line 1, line 2, line 3]
      ],
      description: 'delete first then insert new first',
    };
    const r = applyMutation(SAMPLE, mutation);
    const lines = r.mutated.split('\n');
    expect(lines[0]).toBe('new first');
    expect(lines[1]).toBe('line 1');
    expect(lines).toHaveLength(4);
  });

  it('preserves original text in result', () => {
    const m = singleOp({ kind: 'replace', target: 0, content: 'changed' });
    const r = applyMutation(SAMPLE, m);
    expect(r.original).toBe(SAMPLE);
    expect(r.mutated).not.toBe(SAMPLE);
  });
});

// ── singleOp helper ─────────────────────────────────────────────────

describe('singleOp', () => {
  it('creates a mutation with default description', () => {
    const m = singleOp({ kind: 'delete', target: 2 });
    expect(m.ops).toHaveLength(1);
    expect(m.description).toContain('delete');
    expect(m.description).toContain('2');
  });

  it('uses custom description', () => {
    const m = singleOp({ kind: 'insert', target: 0, content: 'x' }, 'custom desc');
    expect(m.description).toBe('custom desc');
  });
});
