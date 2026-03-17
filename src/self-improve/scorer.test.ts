import { describe, it, expect } from 'vitest';
import { paramMatchScore, scoreTestCase, scoreBatch } from './scorer.js';
import type { FrozenTestCase, ExpectedAction } from './types.js';

// ── paramMatchScore ─────────────────────────────────────────────────

describe('paramMatchScore', () => {
  it('returns 1.0 when expected has no params', () => {
    expect(paramMatchScore(undefined, undefined)).toBe(1.0);
    expect(paramMatchScore({}, {})).toBe(1.0);
    expect(paramMatchScore(undefined, { extra: 1 })).toBe(1.0);
  });

  it('returns 0.0 when actual is missing but expected has params', () => {
    expect(paramMatchScore({ channel: 'gen' }, undefined)).toBe(0.0);
  });

  it('scores fraction of matching params', () => {
    const expected = { a: 1, b: 2, c: 3 };
    const actual = { a: 1, b: 99, c: 3, d: 4 };
    expect(paramMatchScore(expected, actual)).toBeCloseTo(2 / 3);
  });

  it('handles all params matching', () => {
    const p = { x: 'hello', y: [1, 2] };
    expect(paramMatchScore(p, { ...p })).toBe(1.0);
  });

  it('handles nested objects', () => {
    const expected = { opts: { a: 1, b: 2 } };
    const actual = { opts: { a: 1, b: 2 } };
    expect(paramMatchScore(expected, actual)).toBe(1.0);
  });

  it('detects nested mismatch', () => {
    const expected = { opts: { a: 1 } };
    const actual = { opts: { a: 2 } };
    expect(paramMatchScore(expected, actual)).toBe(0.0);
  });
});

// ── scoreTestCase ───────────────────────────────────────────────────

describe('scoreTestCase', () => {
  const tc: FrozenTestCase = {
    id: 'tc-1',
    prompt: 'list channels',
    expectedActions: [{ type: 'channelList' }],
  };

  it('scores 1.0 for exact type match with no params', () => {
    const result = scoreTestCase(tc, [{ type: 'channelList' }]);
    expect(result.score).toBe(1.0);
    expect(result.matches[0].typeMatch).toBe(true);
    expect(result.matches[0].score).toBe(1.0);
  });

  it('scores 0.0 when no actual actions match', () => {
    const result = scoreTestCase(tc, [{ type: 'sendMessage' }]);
    expect(result.score).toBe(0.0);
    expect(result.matches[0].actual).toBeNull();
  });

  it('scores 0.0 when actual is empty', () => {
    const result = scoreTestCase(tc, []);
    expect(result.score).toBe(0.0);
  });

  it('scores partial param match', () => {
    const withParams: FrozenTestCase = {
      id: 'tc-2',
      prompt: 'send msg',
      expectedActions: [{ type: 'sendMessage', params: { channel: 'gen', content: 'hi' } }],
    };
    const actual: ExpectedAction[] = [
      { type: 'sendMessage', params: { channel: 'gen', content: 'wrong' } },
    ];
    const result = scoreTestCase(withParams, actual);
    // type matches (0.6), params 1/2 match (0.4 * 0.5 = 0.2) → 0.8
    expect(result.score).toBeCloseTo(0.8);
  });

  it('uses greedy best-match for multiple expected actions', () => {
    const multi: FrozenTestCase = {
      id: 'tc-3',
      prompt: 'two actions',
      expectedActions: [
        { type: 'channelList' },
        { type: 'sendMessage', params: { content: 'done' } },
      ],
    };
    const actual: ExpectedAction[] = [
      { type: 'sendMessage', params: { content: 'done' } },
      { type: 'channelList' },
    ];
    const result = scoreTestCase(multi, actual);
    // Both should match perfectly regardless of order
    expect(result.score).toBe(1.0);
    expect(result.matches).toHaveLength(2);
  });

  it('handles more expected than actual', () => {
    const multi: FrozenTestCase = {
      id: 'tc-4',
      prompt: 'three expected',
      expectedActions: [
        { type: 'channelList' },
        { type: 'sendMessage' },
        { type: 'memberInfo' },
      ],
    };
    const actual: ExpectedAction[] = [{ type: 'channelList' }];
    const result = scoreTestCase(multi, actual);
    // 1 match at 1.0, 2 misses at 0.0 → mean = 1/3
    expect(result.score).toBeCloseTo(1 / 3);
  });

  it('does not reuse actual actions', () => {
    const multi: FrozenTestCase = {
      id: 'tc-5',
      prompt: 'two same type expected',
      expectedActions: [{ type: 'channelList' }, { type: 'channelList' }],
    };
    const actual: ExpectedAction[] = [{ type: 'channelList' }];
    const result = scoreTestCase(multi, actual);
    // Only one can match → 1.0 + 0.0 → mean 0.5
    expect(result.score).toBeCloseTo(0.5);
  });
});

// ── scoreBatch ──────────────────────────────────────────────────────

describe('scoreBatch', () => {
  it('scores multiple test cases and computes mean', () => {
    const cases: FrozenTestCase[] = [
      { id: 'a', prompt: 'p1', expectedActions: [{ type: 'channelList' }] },
      { id: 'b', prompt: 'p2', expectedActions: [{ type: 'sendMessage' }] },
    ];
    const actuals = new Map<string, ExpectedAction[]>([
      ['a', [{ type: 'channelList' }]],
      ['b', []], // miss
    ]);
    const { results, meanScore } = scoreBatch(cases, actuals);
    expect(results).toHaveLength(2);
    expect(results[0].score).toBe(1.0);
    expect(results[1].score).toBe(0.0);
    expect(meanScore).toBeCloseTo(0.5);
  });

  it('returns 0 mean for empty test cases', () => {
    const { results, meanScore } = scoreBatch([], new Map());
    expect(results).toEqual([]);
    expect(meanScore).toBe(0);
  });

  it('uses empty actual array for missing test case IDs', () => {
    const cases: FrozenTestCase[] = [
      { id: 'missing', prompt: 'p', expectedActions: [{ type: 'x' }] },
    ];
    const { results } = scoreBatch(cases, new Map());
    expect(results[0].score).toBe(0);
  });
});
