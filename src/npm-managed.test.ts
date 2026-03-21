import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import {
  getLocalVersion,
  getLatestNpmVersion,
  getNpmManagedClaude1p0Audit,
  getNpmManagedClaude1p0BlockedSurfaces,
  getNpmManagedClaude1p0ClaimableSurfaces,
  isNpmManaged,
  NPM_MANAGED_CLAUDE_1P0_AUDIT,
  npmGlobalUpgrade,
} from './npm-managed.js';

// ---------------------------------------------------------------------------
// getLocalVersion
// ---------------------------------------------------------------------------

describe('getLocalVersion', () => {
  it('returns a semver-shaped version string from package.json', () => {
    const v = getLocalVersion();
    expect(typeof v).toBe('string');
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// npm-managed Claude 1.0 audit
// ---------------------------------------------------------------------------

describe('NPM_MANAGED_CLAUDE_1P0_AUDIT', () => {
  it('pins the current 1.0 verdict to not yet support-claimable', () => {
    const audit = getNpmManagedClaude1p0Audit();

    expect(audit).toBe(NPM_MANAGED_CLAUDE_1P0_AUDIT);
    expect(audit.releaseGate).toBe('1.0');
    expect(audit.installCommand).toBe('npm install -g discoclaw');
    expect(audit.verdict).toBe('not-yet-support-claimable');
    expect(audit.supportClaimable).toBe(false);
  });

  it('keeps the claimable surfaces narrowed to install and update mechanics', () => {
    expect(getNpmManagedClaude1p0ClaimableSurfaces()).toEqual([
      expect.objectContaining({ id: 'global-install', supportClaimable: true, state: 'supported' }),
      expect.objectContaining({ id: 'update', supportClaimable: true, state: 'supported' }),
    ]);
  });

  it('keeps auth, daemon, first reply, and restart explicitly blocked', () => {
    expect(getNpmManagedClaude1p0BlockedSurfaces()).toEqual([
      expect.objectContaining({
        id: 'init-login-validation',
        blockerCodes: ['missing-shipped-auth-smoke', 'missing-claude-bin-persistence'],
      }),
      expect.objectContaining({
        id: 'daemon-install-startup',
        blockerCodes: ['missing-claude-bin-persistence', 'daemon-runtime-path-mismatch'],
      }),
      expect.objectContaining({
        id: 'first-useful-reply',
        blockerCodes: ['blocked-by-auth-and-daemon-gaps'],
      }),
      expect.objectContaining({
        id: 'restart-recovery',
        blockerCodes: ['daemon-runtime-path-mismatch'],
      }),
    ]);
  });

  it('retains the full blocker set for the npm-managed Claude path', () => {
    const blockerCodes = NPM_MANAGED_CLAUDE_1P0_AUDIT.blockers.map((blocker) => blocker.code);

    expect(blockerCodes).toEqual([
      'missing-shipped-auth-smoke',
      'missing-claude-bin-persistence',
      'daemon-runtime-path-mismatch',
      'blocked-by-auth-and-daemon-gaps',
    ]);
  });
});

// ---------------------------------------------------------------------------
// isNpmManaged
// ---------------------------------------------------------------------------

describe('isNpmManaged', () => {
  let mockExistsSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('node:fs');
    mockExistsSync = mod.existsSync as unknown as ReturnType<typeof vi.fn>;
    mockExistsSync.mockReset();
  });

  it('returns false (source install) when .git exists at the package root', async () => {
    mockExistsSync.mockReturnValue(true);
    expect(await isNpmManaged()).toBe(false);
  });

  it('returns true (npm-managed) when .git does not exist at the package root', async () => {
    mockExistsSync.mockReturnValue(false);
    expect(await isNpmManaged()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getLatestNpmVersion
// ---------------------------------------------------------------------------

describe('getLatestNpmVersion', () => {
  let mockExeca: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('execa');
    mockExeca = mod.execa as unknown as ReturnType<typeof vi.fn>;
    mockExeca.mockReset();
  });

  it('returns the trimmed version string from the registry', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '1.2.3\n' });
    expect(await getLatestNpmVersion()).toBe('1.2.3');
    expect(mockExeca).toHaveBeenCalledWith('npm', ['show', 'discoclaw', 'version'], {
      timeout: 15_000,
    });
  });

  it('trims surrounding whitespace from npm output', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '  2.0.0  \n' });
    expect(await getLatestNpmVersion()).toBe('2.0.0');
  });

  it('returns null when npm show fails', async () => {
    mockExeca.mockRejectedValueOnce(new Error('network error'));
    expect(await getLatestNpmVersion()).toBeNull();
  });

  it('returns null when npm output is empty', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '' });
    expect(await getLatestNpmVersion()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// npmGlobalUpgrade
// ---------------------------------------------------------------------------

describe('npmGlobalUpgrade', () => {
  let mockExeca: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('execa');
    mockExeca = mod.execa as unknown as ReturnType<typeof vi.fn>;
    mockExeca.mockReset();
  });

  it('returns exitCode 0 and captured output on success', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: 'added discoclaw@1.2.3', stderr: '' });
    const result = await npmGlobalUpgrade();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('added discoclaw@1.2.3');
    expect(result.stderr).toBe('');
    expect(mockExeca).toHaveBeenCalledWith('npm', ['install', '-g', 'discoclaw', '--loglevel=error'], {
      timeout: 120_000,
    });
  });

  it('returns a non-zero exitCode and stderr when npm install fails', async () => {
    const err: any = new Error('install failed');
    err.exitCode = 1;
    err.stdout = '';
    err.stderr = 'EACCES: permission denied';
    mockExeca.mockRejectedValueOnce(err);
    const result = await npmGlobalUpgrade();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('EACCES: permission denied');
  });

  it('defaults to exitCode 1 when the thrown error carries no exitCode', async () => {
    mockExeca.mockRejectedValueOnce(new Error('unexpected error'));
    const result = await npmGlobalUpgrade();
    expect(result.exitCode).toBe(1);
  });
});
