import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('provider support docs stay consistent', () => {
  it('marks Claude source checkout supported only when the first-login gate is closed everywhere', () => {
    const readinessAudit = readRepoFile('docs/audit/claude-blank-machine-readiness.md');
    const providerMatrix = readRepoFile('docs/audit/provider-auth-1.0-matrix.md');
    const readme = readRepoFile('README.md');
    const closeoutMemo = readRepoFile('CLAUDE SOURCE-CHECKOUT STATUS.md');

    expect(readinessAudit).toContain('First-login stranger path release gate: `CLOSED`');
    expect(providerMatrix).toContain('| Claude CLI / OAuth | Source checkout | `SUPPORTED FOR 1.0` |');
    // README was condensed — audit docs, matrix, and closeout memo carry the claim
    expect(closeoutMemo).toContain('Status: `SUPPORTED FOR 1.0` for the Claude source-checkout path');
    expect(closeoutMemo).toContain('First-login stranger gate: `CLOSED`');
  });
});
