import { describe, it, expect } from 'vitest';
import { formatConsoleTable, formatSummary } from '../reporter.js';
import type { ScoreResult } from '../types.js';

// ── formatConsoleTable ──────────────────────────────────────────────

describe('formatConsoleTable', () => {
  const results: ScoreResult[] = [
    {
      testCaseId: 'tc-1',
      matches: [
        { expected: { type: 'channelList' }, actual: { type: 'channelList' }, typeMatch: true, paramScore: 1, score: 1.0 },
      ],
      violations: [],
      score: 1.0,
    },
    {
      testCaseId: 'tc-2',
      matches: [
        { expected: { type: 'sendMessage' }, actual: null, typeMatch: false, paramScore: 0, score: 0 },
      ],
      violations: [],
      score: 0,
    },
  ];

  it('includes a header row with expected columns', () => {
    const table = formatConsoleTable(results, 0.5);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/Test Case ID/);
    expect(lines[0]).toMatch(/Score/);
    expect(lines[0]).toMatch(/Actions/);
    expect(lines[0]).toMatch(/Violations/);
    expect(lines[0]).toMatch(/Status/);
  });

  it('includes a separator after the header', () => {
    const table = formatConsoleTable(results, 0.5);
    const lines = table.split('\n');
    expect(lines[1]).toMatch(/^-+/);
  });

  it('includes one row per test case', () => {
    const table = formatConsoleTable(results, 0.5);
    const lines = table.split('\n');
    // header + separator + 2 data rows + separator + mean line = 6
    expect(lines).toHaveLength(6);
  });

  it('shows pass for score 1.0', () => {
    const table = formatConsoleTable(results, 0.5);
    expect(table).toContain('pass');
  });

  it('shows fail for score 0', () => {
    const table = formatConsoleTable(results, 0.5);
    expect(table).toContain('fail');
  });

  it('shows partial for scores between 0 and 1', () => {
    const partial: ScoreResult[] = [
      {
        testCaseId: 'tc-partial',
        matches: [
          { expected: { type: 'sendMessage' }, actual: { type: 'sendMessage' }, typeMatch: true, paramScore: 0.5, score: 0.8 },
        ],
        violations: [],
        score: 0.8,
      },
    ];
    const table = formatConsoleTable(partial, 0.8);
    expect(table).toContain('partial');
  });

  it('shows matched/total action counts', () => {
    const table = formatConsoleTable(results, 0.5);
    expect(table).toContain('1/1');
    expect(table).toContain('0/1');
  });

  it('includes mean score in footer', () => {
    const table = formatConsoleTable(results, 0.5);
    expect(table).toContain('Mean score: 0.500');
  });

  it('handles empty results', () => {
    const table = formatConsoleTable([], 0);
    expect(table).toContain('Mean score: 0.000');
  });

  it('shows VIOLATION status when violations exist', () => {
    const withViolation: ScoreResult[] = [
      {
        testCaseId: 'tc-violated',
        matches: [],
        violations: [{ forbiddenType: 'deleteMessage', actual: { type: 'deleteMessage' } }],
        score: 0.5,
      },
    ];
    const table = formatConsoleTable(withViolation, 0.5);
    expect(table).toContain('VIOLATION');
    expect(table).toContain('deleteMessage');
  });

  it('shows dash for no violations', () => {
    const table = formatConsoleTable(results, 0.5);
    expect(table).toContain('-');
  });
});

// ── formatSummary ───────────────────────────────────────────────────

describe('formatSummary', () => {
  it('formats a promoted summary with positive delta', () => {
    const summary = formatSummary(0.8, 0.5, true);
    expect(summary).toContain('Score: 0.800');
    expect(summary).toContain('prev best: 0.500');
    expect(summary).toContain('delta: +0.300');
    expect(summary).toContain('[PROMOTED]');
  });

  it('formats a non-promoted summary', () => {
    const summary = formatSummary(0.4, 0.5, false);
    expect(summary).toContain('Score: 0.400');
    expect(summary).toContain('delta: -0.100');
    expect(summary).not.toContain('[PROMOTED]');
  });

  it('shows +0.000 delta when scores are equal', () => {
    const summary = formatSummary(0.5, 0.5, false);
    expect(summary).toContain('delta: +0.000');
  });

  it('formats zero scores correctly', () => {
    const summary = formatSummary(0, 0, false);
    expect(summary).toContain('Score: 0.000');
    expect(summary).toContain('prev best: 0.000');
  });
});
