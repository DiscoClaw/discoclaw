import { describe, it, expect } from 'vitest';
import { buildFailureSummary, buildMutationPrompt, parseProposal } from './ai-mutator.js';
import { applyMutation } from './mutator.js';
import type { ScoreResult } from './types.js';

// ── buildFailureSummary ─────────────────────────────────────────────

describe('buildFailureSummary', () => {
  it('reports all-pass when every score is 1.0', () => {
    const results: ScoreResult[] = [
      { testCaseId: 'test-1', matches: [], violations: [], score: 1.0 },
      { testCaseId: 'test-2', matches: [], violations: [], score: 1.0 },
    ];
    expect(buildFailureSummary(results)).toContain('All test cases passed');
  });

  it('lists failures with details', () => {
    const results: ScoreResult[] = [
      {
        testCaseId: 'guard-no-delete',
        matches: [
          { expected: { type: 'deleteMessage' }, actual: null, typeMatch: false, paramScore: 0, score: 0 },
        ],
        violations: [{ forbiddenType: 'deleteMessage', actual: { type: 'deleteMessage' } }],
        score: 0,
      },
      { testCaseId: 'passing', matches: [], violations: [], score: 1.0 },
    ];
    const summary = buildFailureSummary(results);
    expect(summary).toContain('1 test case(s)');
    expect(summary).toContain('guard-no-delete');
    expect(summary).toContain('deleteMessage');
    expect(summary).toContain('Violations');
  });

  it('includes partial match details', () => {
    const results: ScoreResult[] = [
      {
        testCaseId: 'partial-test',
        matches: [
          { expected: { type: 'sendMessage' }, actual: { type: 'sendMessage' }, typeMatch: true, paramScore: 0.5, score: 0.8 },
        ],
        violations: [],
        score: 0.8,
      },
    ];
    const summary = buildFailureSummary(results);
    expect(summary).toContain('Partial matches');
    expect(summary).toContain('sendMessage');
  });
});

// ── buildMutationPrompt ─────────────────────────────────────────────

describe('buildMutationPrompt', () => {
  it('includes the instruction text and score', () => {
    const instructions = '# Rules\n- Do not delete\n- Always ask first';
    const results: ScoreResult[] = [
      { testCaseId: 'test-1', matches: [], violations: [], score: 0.5 },
    ];
    const prompt = buildMutationPrompt(instructions, results, 0.5);
    expect(prompt).toContain('Mean score: 0.500');
    expect(prompt).toContain('# Rules');
    expect(prompt).toContain('Do not delete');
    expect(prompt).toContain('3 lines');
  });

  it('includes valid JSON format instructions', () => {
    const prompt = buildMutationPrompt('line 0', [], 1.0);
    expect(prompt).toContain('"kind"');
    expect(prompt).toContain('"target"');
    expect(prompt).toContain('"content"');
  });
});

// ── parseProposal ───────────────────────────────────────────────────

describe('parseProposal', () => {
  it('parses a valid insert proposal', () => {
    const raw = JSON.stringify({
      reasoning: 'Adding a rule to prevent deletion',
      description: 'Add anti-deletion guardrail',
      ops: [{ kind: 'insert', target: 2, content: '- NEVER delete without confirmation' }],
    });
    const proposal = parseProposal(raw, 10);
    expect(proposal.description).toBe('Add anti-deletion guardrail');
    expect(proposal.reasoning).toContain('deletion');
    expect(proposal.ops).toHaveLength(1);
    expect(proposal.ops[0].kind).toBe('insert');
    expect(proposal.ops[0].target).toBe(2);
    expect(proposal.ops[0].content).toContain('NEVER delete');
  });

  it('parses a replace proposal', () => {
    const raw = JSON.stringify({
      reasoning: 'Strengthening a weak rule',
      description: 'Replace SHOULD with MUST',
      ops: [{ kind: 'replace', target: 5, content: 'You MUST ask before deleting.' }],
    });
    const proposal = parseProposal(raw, 10);
    expect(proposal.ops[0].kind).toBe('replace');
    expect(proposal.ops[0].content).toContain('MUST');
  });

  it('parses a delete proposal', () => {
    const raw = JSON.stringify({
      reasoning: 'Removing a confusing rule',
      description: 'Remove redundant line',
      ops: [{ kind: 'delete', target: 3 }],
    });
    const proposal = parseProposal(raw, 10);
    expect(proposal.ops[0].kind).toBe('delete');
    expect(proposal.ops[0].target).toBe(3);
  });

  it('parses multi-op proposals', () => {
    const raw = JSON.stringify({
      reasoning: 'Multi-line fix',
      description: 'Fix two issues at once',
      ops: [
        { kind: 'replace', target: 1, content: 'Updated line 1' },
        { kind: 'insert', target: 5, content: 'New guardrail line' },
      ],
    });
    const proposal = parseProposal(raw, 10);
    expect(proposal.ops).toHaveLength(2);
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n' + JSON.stringify({
      reasoning: 'test',
      description: 'test',
      ops: [{ kind: 'delete', target: 0 }],
    }) + '\n```';
    const proposal = parseProposal(raw, 10);
    expect(proposal.ops).toHaveLength(1);
  });

  it('rejects proposals with no ops', () => {
    const raw = JSON.stringify({ reasoning: 'test', description: 'test', ops: [] });
    expect(() => parseProposal(raw, 10)).toThrow('missing "ops"');
  });

  it('rejects proposals with too many ops', () => {
    const ops = Array.from({ length: 11 }, (_, i) => ({ kind: 'delete', target: i }));
    const raw = JSON.stringify({ reasoning: 'test', description: 'test', ops });
    expect(() => parseProposal(raw, 20)).toThrow('max is 10');
  });

  it('rejects invalid op kinds', () => {
    const raw = JSON.stringify({
      reasoning: 'test',
      description: 'test',
      ops: [{ kind: 'explode', target: 0 }],
    });
    expect(() => parseProposal(raw, 10)).toThrow('Invalid op kind');
  });

  it('rejects insert without content', () => {
    const raw = JSON.stringify({
      reasoning: 'test',
      description: 'test',
      ops: [{ kind: 'insert', target: 0 }],
    });
    expect(() => parseProposal(raw, 10)).toThrow('requires "content"');
  });

  it('rejects negative target', () => {
    const raw = JSON.stringify({
      reasoning: 'test',
      description: 'test',
      ops: [{ kind: 'delete', target: -1 }],
    });
    expect(() => parseProposal(raw, 10)).toThrow('Invalid op target');
  });

  it('produces ops that applyMutation can execute', () => {
    const text = 'line 0\nline 1\nline 2\nline 3\nline 4';
    const raw = JSON.stringify({
      reasoning: 'test',
      description: 'test replace',
      ops: [{ kind: 'replace', target: 2, content: 'REPLACED LINE' }],
    });
    const proposal = parseProposal(raw, 5);
    const result = applyMutation(text, { ops: proposal.ops, description: proposal.description });
    expect(result.mutated).toContain('REPLACED LINE');
    expect(result.mutated.split('\n')).toHaveLength(5);
  });

  it('defaults missing reasoning and description', () => {
    const raw = JSON.stringify({
      ops: [{ kind: 'delete', target: 0 }],
    });
    const proposal = parseProposal(raw, 10);
    expect(proposal.description).toBe('AI-guided mutation');
    expect(proposal.reasoning).toBe('');
  });
});
