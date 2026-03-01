import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { getLocalVersion, getLatestNpmVersion, isNpmManaged, npmGlobalUpgrade } from './npm-managed.js';

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
      env: expect.objectContaining({ CFLAGS: '-Wno-incompatible-pointer-types' }),
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
