import { describe, expect, it } from 'vitest';
import {
  createEvidence,
  formatEvidenceLine,
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
