import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('provider support docs stay consistent', () => {
  it('does not mark Claude source checkout as supported while the first-login gate is open', () => {
    const readinessAudit = readRepoFile('docs/audit/claude-blank-machine-readiness.md');
    const providerMatrix = readRepoFile('docs/audit/provider-auth-1.0-matrix.md');
    const readme = readRepoFile('README.md');
    const closeoutMemo = readRepoFile('CLAUDE SOURCE-CHECKOUT STATUS.md');

    expect(readinessAudit).toContain('First-login stranger path release gate: `OPEN`');
    expect(providerMatrix).toContain('| Claude CLI / OAuth | Source checkout | `PARTIAL` |');
    expect(readme).toContain('Source-checkout 1.0 support status: `PARTIAL` for the repo-owned Claude path');
    expect(closeoutMemo).toContain('Status: `PARTIAL` for the Claude source-checkout path');
    expect(closeoutMemo).toContain('Current support-safe claim: `fresh-clone post-login path proven`');
  });
});
