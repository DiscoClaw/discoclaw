import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
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
  let mockExeca: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('execa');
    mockExeca = mod.execa as unknown as ReturnType<typeof vi.fn>;
    mockExeca.mockReset();
  });

  it('returns true when process.argv[1] is under the npm global root', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '/usr/local/lib/node_modules\n' });
    const orig = process.argv[1];
    process.argv[1] = '/usr/local/lib/node_modules/discoclaw/dist/cli/index.js';
    try {
      expect(await isNpmManaged()).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith('npm', ['root', '-g']);
    } finally {
      process.argv[1] = orig;
    }
  });

  it('returns false when process.argv[1] is outside the npm global root', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '/usr/local/lib/node_modules\n' });
    const orig = process.argv[1];
    process.argv[1] = '/home/user/code/discoclaw/src/index.ts';
    try {
      expect(await isNpmManaged()).toBe(false);
    } finally {
      process.argv[1] = orig;
    }
  });

  it('returns false when npm root -g fails', async () => {
    mockExeca.mockRejectedValueOnce(new Error('npm not found'));
    expect(await isNpmManaged()).toBe(false);
  });

  it('returns false when npm root -g returns empty output', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '   ' });
    expect(await isNpmManaged()).toBe(false);
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
    expect(mockExeca).toHaveBeenCalledWith('npm', ['install', '-g', 'discoclaw'], {
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
