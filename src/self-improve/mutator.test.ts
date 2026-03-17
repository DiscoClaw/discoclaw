import { describe, it, expect } from 'vitest';
import {
  applyMutation,
  singleOp,
  generateRandomMutation,
  generateTargetedMutations,
  generateMutation,
  analyseStructure,
  MutationError,
} from './mutator.js';
import type { Mutation } from './types.js';

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

// ── generateRandomMutation ─────────────────────────────────────────

describe('generateRandomMutation', () => {
  it('generates a valid delete mutation for single-line text', () => {
    // Single line → only delete is available
    const m = generateRandomMutation('only line', () => 0);
    expect(m.ops).toHaveLength(1);
    expect(m.ops[0].kind).toBe('delete');
    expect(m.ops[0].target).toBe(0);
  });

  it('generates a swap mutation when rng selects it', () => {
    // Multi-line text: kinds = ['delete', 'swap']
    // rng returning 0.5 → floor(0.5 * 2) = 1 → 'swap'
    const m = generateRandomMutation('line 0\nline 1\nline 2', () => 0.5);
    expect(m.ops).toHaveLength(1);
    expect(m.ops[0].kind).toBe('swap');
    expect(m.ops[0].swapWith).toBeDefined();
    expect(m.ops[0].target).not.toBe(m.ops[0].swapWith);
  });

  it('generates a delete mutation when rng selects it', () => {
    // Multi-line text: kinds = ['delete', 'swap']
    // rng returning 0 → floor(0 * 2) = 0 → 'delete'
    const m = generateRandomMutation('line 0\nline 1\nline 2', () => 0);
    expect(m.ops).toHaveLength(1);
    expect(m.ops[0].kind).toBe('delete');
    expect(m.ops[0].target).toBe(0);
  });

  it('handles empty text gracefully', () => {
    const m = generateRandomMutation('', () => 0);
    expect(m.ops).toHaveLength(1);
    expect(m.ops[0].kind).toBe('insert');
  });

  it('produces mutations that applyMutation can execute', () => {
    const text = 'line 0\nline 1\nline 2\nline 3';
    // Run several deterministic seeds and verify each is applicable
    for (const seed of [0, 0.1, 0.25, 0.5, 0.75, 0.99]) {
      const m = generateRandomMutation(text, () => seed);
      const result = applyMutation(text, m);
      expect(result.mutated).toBeDefined();
      expect(result.original).toBe(text);
    }
  });

  it('swap always picks two different lines', () => {
    const text = 'a\nb';
    // kinds = ['delete','swap'], rng=0.5 → swap, then a=floor(0.5*2)=1, b=floor(0.5*1)=0
    const m = generateRandomMutation(text, () => 0.5);
    expect(m.ops[0].kind).toBe('swap');
    expect(m.ops[0].target).not.toBe(m.ops[0].swapWith);
  });
});

// ── analyseStructure ──────────────────────────────────────────────

const STRUCTURED_TEXT = `# Section One
Rule A
- Bullet 1
- Bullet 2

## Section Two
You MUST do this.
You NEVER skip that.

## Section Three
- Item X
- Item Y
Final line`;

describe('analyseStructure', () => {
  it('identifies headings as sections', () => {
    const s = analyseStructure(STRUCTURED_TEXT);
    expect(s.sections).toHaveLength(3);
    expect(s.sections[0].heading).toBe('# Section One');
    expect(s.sections[0].depth).toBe(1);
    expect(s.sections[1].heading).toBe('## Section Two');
    expect(s.sections[1].depth).toBe(2);
    expect(s.sections[2].heading).toBe('## Section Three');
  });

  it('computes section boundaries correctly', () => {
    const s = analyseStructure(STRUCTURED_TEXT);
    // Section One starts at 0, ends at section Two's start (5)
    expect(s.sections[0].start).toBe(0);
    expect(s.sections[0].end).toBe(5);
    // Section Two starts at 5, ends at section Three's start (9)
    expect(s.sections[1].start).toBe(5);
    expect(s.sections[1].end).toBe(9);
    // Section Three goes to the end
    expect(s.sections[2].start).toBe(9);
    expect(s.sections[2].end).toBe(13);
  });

  it('identifies bullet items', () => {
    const s = analyseStructure(STRUCTURED_TEXT);
    expect(s.bullets.length).toBeGreaterThanOrEqual(4);
    expect(s.bullets[0].line).toBe(2);
    expect(s.bullets[0].text).toBe('- Bullet 1');
  });

  it('handles text with no headings', () => {
    const s = analyseStructure('just\nplain\ntext');
    expect(s.sections).toHaveLength(0);
    expect(s.lineCount).toBe(3);
  });

  it('handles empty text', () => {
    const s = analyseStructure('');
    expect(s.sections).toHaveLength(0);
    expect(s.bullets).toHaveLength(0);
    expect(s.lineCount).toBe(1);
  });
});

// ── generateTargetedMutations ─────────────────────────────────────

describe('generateTargetedMutations', () => {
  it('returns multiple mutation strategies for structured text', () => {
    const mutations = generateTargetedMutations(STRUCTURED_TEXT, () => 0.5);
    // Should get at least: removeSection, swapSections, removeBullet, weakenDirective, duplicateBullet
    expect(mutations.length).toBeGreaterThanOrEqual(4);
  });

  it('each mutation is applicable via applyMutation', () => {
    const mutations = generateTargetedMutations(STRUCTURED_TEXT, () => 0.3);
    for (const m of mutations) {
      const result = applyMutation(STRUCTURED_TEXT, m);
      expect(result.mutated).toBeDefined();
      expect(result.original).toBe(STRUCTURED_TEXT);
    }
  });

  it('returns empty array for empty text', () => {
    expect(generateTargetedMutations('', () => 0)).toEqual([]);
  });

  it('returns empty array for text with no structure', () => {
    // Plain text with no headings, bullets, or directives — only some strategies may apply
    const plain = 'hello world';
    const mutations = generateTargetedMutations(plain, () => 0);
    // No sections, no bullets, no directives — should be empty
    expect(mutations).toHaveLength(0);
  });

  it('removeSection produces correct ops', () => {
    const mutations = generateTargetedMutations(STRUCTURED_TEXT, () => 0);
    const removeSec = mutations.find((m) => m.description.startsWith('remove section'));
    expect(removeSec).toBeDefined();
    // Applying it should reduce line count
    const result = applyMutation(STRUCTURED_TEXT, removeSec!);
    expect(result.mutated.split('\n').length).toBeLessThan(STRUCTURED_TEXT.split('\n').length);
  });

  it('swapSections produces swapped content', () => {
    // rng=0.5 so both section picks are deterministic
    const mutations = generateTargetedMutations(STRUCTURED_TEXT, () => 0.5);
    const swapSec = mutations.find((m) => m.description.startsWith('swap sections'));
    expect(swapSec).toBeDefined();
    const result = applyMutation(STRUCTURED_TEXT, swapSec!);
    // Line count should be preserved (swap doesn't add or remove lines)
    expect(result.mutated.split('\n').length).toBe(STRUCTURED_TEXT.split('\n').length);
    expect(result.mutated).not.toBe(STRUCTURED_TEXT);
  });

  it('weakenDirective replaces strong language', () => {
    const mutations = generateTargetedMutations(STRUCTURED_TEXT, () => 0);
    const weaken = mutations.find((m) => m.description.startsWith('weaken directive'));
    expect(weaken).toBeDefined();
    const result = applyMutation(STRUCTURED_TEXT, weaken!);
    // The mutated text should have weaker language
    const hasWeakened =
      result.mutated.includes('SHOULD') ||
      result.mutated.includes('AVOID') ||
      result.mutated.includes('USUALLY') ||
      result.mutated.includes('recommended') ||
      result.mutated.includes('Try not to');
    expect(hasWeakened).toBe(true);
  });

  it('removeBullet removes exactly one line', () => {
    const mutations = generateTargetedMutations(STRUCTURED_TEXT, () => 0);
    const removeBul = mutations.find((m) => m.description.startsWith('remove bullet'));
    expect(removeBul).toBeDefined();
    expect(removeBul!.ops).toHaveLength(1);
    expect(removeBul!.ops[0].kind).toBe('delete');
  });

  it('duplicateBullet adds exactly one line', () => {
    const mutations = generateTargetedMutations(STRUCTURED_TEXT, () => 0);
    const dupBul = mutations.find((m) => m.description.startsWith('duplicate bullet'));
    expect(dupBul).toBeDefined();
    expect(dupBul!.ops).toHaveLength(1);
    expect(dupBul!.ops[0].kind).toBe('insert');
    const result = applyMutation(STRUCTURED_TEXT, dupBul!);
    expect(result.mutated.split('\n').length).toBe(STRUCTURED_TEXT.split('\n').length + 1);
  });
});

// ── generateMutation ──────────────────────────────────────────────

describe('generateMutation', () => {
  it('returns a targeted mutation for structured text', () => {
    const m = generateMutation(STRUCTURED_TEXT, () => 0.5);
    expect(m.ops.length).toBeGreaterThanOrEqual(1);
    // Should be a targeted mutation (has descriptive text, not just "delete line N")
    expect(m.description.length).toBeGreaterThan(0);
  });

  it('falls back to random for unstructured text', () => {
    const m = generateMutation('single line', () => 0);
    expect(m.ops).toHaveLength(1);
    // Only delete is possible for single-line text
    expect(m.ops[0].kind).toBe('delete');
  });

  it('always produces applicable mutations', () => {
    for (const seed of [0, 0.1, 0.3, 0.5, 0.7, 0.99]) {
      const m = generateMutation(STRUCTURED_TEXT, () => seed);
      const result = applyMutation(STRUCTURED_TEXT, m);
      expect(result.mutated).toBeDefined();
    }
  });
});
