import { describe, expect, it } from 'vitest';
import {
  collectRunEvidence,
  coerceEvidenceArray,
  createEvidence,
  deriveVerificationState,
  formatEvidenceLine,
  formatEvidenceSummary,
  formatVerificationBadge,
} from './verification-evidence.js';

describe('createEvidence', () => {
  it('creates canonical pass evidence and trims optional fields', () => {
    expect(createEvidence({
      kind: 'test',
      status: 'pass',
      command: ' pnpm test ',
      summary: ' 14 passed ',
    })).toEqual({
      kind: 'test',
      status: 'pass',
      command: 'pnpm test',
      summary: '14 passed',
    });
  });

  it('omits blank optional fields', () => {
    expect(createEvidence({
      kind: 'build',
      status: 'pass',
      command: '   ',
      summary: '\n',
    })).toEqual({
      kind: 'build',
      status: 'pass',
    });
  });

  it('requires a reason for failed evidence', () => {
    expect(() => createEvidence({
      kind: 'audit',
      status: 'fail',
      reason: '   ',
    })).toThrow('Failed verification evidence requires a reason');
  });

  it('rejects a reason on passed evidence', () => {
    expect(() => createEvidence({
      kind: 'build',
      status: 'pass',
      reason: 'not needed',
    })).toThrow('Passed verification evidence cannot include a reason');
  });

  it('rejects unknown kinds and statuses', () => {
    expect(() => createEvidence({
      kind: 'lint',
      status: 'pass',
    })).toThrow("Unknown verification evidence kind: 'lint'");

    expect(() => createEvidence({
      kind: 'test',
      status: 'ok',
    })).toThrow("Unknown verification evidence status: 'ok'");
  });
});

describe('formatEvidenceLine', () => {
  it('formats passing evidence with command and summary', () => {
    const evidence = createEvidence({
      kind: 'build',
      status: 'pass',
      command: 'pnpm build',
      summary: 'dist ready',
    });

    expect(formatEvidenceLine(evidence)).toBe('build: pass - pnpm build - dist ready');
  });

  it('formats failed evidence with the failure reason on one line', () => {
    const evidence = createEvidence({
      kind: 'audit',
      status: 'fail',
      reason: 'Blocking findings remain\nin the final audit',
    });

    expect(formatEvidenceLine(evidence)).toBe('audit: fail - Blocking findings remain in the final audit');
  });

  it('formats minimal evidence without extra separators', () => {
    expect(formatEvidenceLine(createEvidence({
      kind: 'test',
      status: 'pass',
    }))).toBe('test: pass');
  });
});

describe('coerceEvidenceArray', () => {
  it('reuses canonical evidence validation for persisted records', () => {
    expect(coerceEvidenceArray([
      { kind: 'build', status: 'pass', command: 'pnpm build', summary: 'clean' },
    ], 'evidence')).toEqual([
      { kind: 'build', status: 'pass', command: 'pnpm build', summary: 'clean' },
    ]);
  });

  it('rejects invalid pass/fail invariants in persisted records', () => {
    expect(() => coerceEvidenceArray([
      { kind: 'audit', status: 'fail' },
    ], 'evidence')).toThrow('Failed verification evidence requires a reason');

    expect(() => coerceEvidenceArray([
      { kind: 'test', status: 'pass', reason: 'should not be here' },
    ], 'evidence')).toThrow('Passed verification evidence cannot include a reason');
  });

  it('can restrict allowed kinds for worker-supplied evidence', () => {
    expect(() => coerceEvidenceArray([
      { kind: 'audit', status: 'fail', reason: 'Blocking findings remain' },
    ], 'phase output evidence', { allowedKinds: ['build', 'test'] })).toThrow(
      "kind 'audit' is not allowed here",
    );
  });
});

describe('formatEvidenceSummary', () => {
  it('formats evidence for compact plan summaries', () => {
    expect(formatEvidenceSummary(createEvidence({
      kind: 'test',
      status: 'pass',
      summary: '14 passed',
    }))).toBe('test: pass (14 passed)');
  });
});

describe('deriveVerificationState', () => {
  it('returns pending for readable terminal runs with read phases and no audit pass', () => {
    expect(deriveVerificationState([
      {
        id: 'phase-1',
        title: 'Implement command parsing',
        kind: 'implement',
        status: 'done',
        evidence: [createEvidence({
          kind: 'build',
          status: 'pass',
          summary: 'dist built cleanly',
        })],
      },
      {
        id: 'phase-2',
        title: 'Read final diff',
        kind: 'read',
        status: 'done',
      },
    ])).toBe('pending');
  });

  it('returns verified when build/test and audit both pass', () => {
    expect(deriveVerificationState([
      {
        id: 'phase-1',
        title: 'Implement feature',
        kind: 'implement',
        status: 'done',
        evidence: [createEvidence({
          kind: 'test',
          status: 'pass',
          summary: 'targeted suite passed',
        })],
      },
      {
        id: 'phase-2',
        title: 'Audit result',
        kind: 'audit',
        status: 'done',
        evidence: [createEvidence({
          kind: 'audit',
          status: 'pass',
          summary: 'blocking review clean',
        })],
      },
    ])).toBe('verified');
  });

  it('ignores failed evidence on skipped phases when deriving the rollup', () => {
    expect(deriveVerificationState([
      {
        id: 'phase-1',
        title: 'Implement feature',
        kind: 'implement',
        status: 'done',
        evidence: [createEvidence({
          kind: 'build',
          status: 'pass',
          summary: 'dist built cleanly',
        })],
      },
      {
        id: 'phase-2',
        title: 'Skipped audit',
        kind: 'audit',
        status: 'skipped',
        evidence: [createEvidence({
          kind: 'audit',
          status: 'fail',
          reason: 'Old blocking finding',
        })],
      },
    ])).toBe('skipped');
  });
});

describe('formatVerificationBadge', () => {
  it('wraps the state in brackets', () => {
    expect(formatVerificationBadge('pending')).toBe('[pending]');
  });
});

describe('collectRunEvidence', () => {
  it('flattens mixed evidence states across run phases', () => {
    const buildEvidence = createEvidence({
      kind: 'build',
      status: 'pass',
      command: 'pnpm build',
      summary: 'dist built cleanly',
    });

    expect(collectRunEvidence([
      {
        id: 'phase-1',
        title: 'Implement command parsing',
        kind: 'implement',
        status: 'done',
        evidence: [buildEvidence],
      },
      {
        id: 'phase-2',
        title: 'Read final diff',
        kind: 'read',
        status: 'done',
      },
      {
        id: 'phase-3',
        title: 'Implement cleanup',
        kind: 'implement',
        status: 'pending',
      },
      {
        id: 'phase-4',
        title: 'Implement tests',
        kind: 'implement',
        status: 'done',
        evidence: [],
      },
    ])).toEqual([
      {
        phaseId: 'phase-1',
        phaseTitle: 'Implement command parsing',
        phaseKind: 'implement',
        phaseStatus: 'done',
        kind: 'build',
        status: 'pass',
        command: 'pnpm build',
        summary: 'dist built cleanly',
      },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(collectRunEvidence([])).toEqual([]);
  });

  it('preserves phase ordering', () => {
    const summaries = collectRunEvidence([
      {
        id: 'phase-2',
        title: 'Second',
        kind: 'audit',
        status: 'failed',
        evidence: [{ kind: 'audit', status: 'fail', reason: 'Blocking findings remain' }],
      },
      { id: 'phase-1', title: 'First', kind: 'read', status: 'done' },
      {
        id: 'phase-3',
        title: 'Third',
        kind: 'implement',
        status: 'skipped',
        evidence: [{ kind: 'build', status: 'pass', summary: 'already built' }],
      },
    ]);

    expect(summaries.map((summary) => summary.phaseId)).toEqual([
      'phase-2',
    ]);
  });

  it('ignores skipped-phase evidence entirely', () => {
    expect(collectRunEvidence([
      {
        id: 'phase-1',
        title: 'Skipped audit',
        kind: 'audit',
        status: 'skipped',
        evidence: [{ kind: 'audit', status: 'fail', reason: 'Old blocking finding' }],
      },
    ])).toEqual([]);
  });

  it('copies phase metadata through unchanged', () => {
    expect(collectRunEvidence([
      {
        id: 'phase-1',
        title: 'Audit',
        kind: 'audit',
        status: 'failed',
        evidence: [{ kind: 'audit', status: 'fail', reason: 'Needs revision' }],
      },
      { id: 'phase-2', title: 'Read', kind: 'read', status: 'done' },
      {
        id: 'phase-3',
        title: 'Implement',
        kind: 'implement',
        status: 'in-progress',
        evidence: [{ kind: 'test', status: 'pass', summary: 'targeted suite passed' }],
      },
    ])).toEqual([
      {
        phaseId: 'phase-1',
        phaseTitle: 'Audit',
        phaseKind: 'audit',
        phaseStatus: 'failed',
        kind: 'audit',
        status: 'fail',
        reason: 'Needs revision',
      },
      {
        phaseId: 'phase-3',
        phaseTitle: 'Implement',
        phaseKind: 'implement',
        phaseStatus: 'in-progress',
        kind: 'test',
        status: 'pass',
        summary: 'targeted suite passed',
      },
    ]);
  });
});
