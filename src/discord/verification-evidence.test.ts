import { describe, expect, it } from 'vitest';
import {
  coerceEvidenceArray,
  createEvidence,
  formatEvidenceLine,
  formatEvidenceSummary,
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
