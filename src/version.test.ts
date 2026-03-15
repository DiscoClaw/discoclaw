import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { getGitHash } from './version.js';

describe('getGitHash', () => {
  let mockExeca: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('execa');
    mockExeca = mod.execa as unknown as ReturnType<typeof vi.fn>;
    mockExeca.mockReset();
  });

  it('returns the short hash from git rev-parse output', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: 'f52710d\n' });

    const hash = await getGitHash();

    expect(hash).toBe('f52710d');
    expect(mockExeca).toHaveBeenCalledWith('git', ['rev-parse', '--short', 'HEAD']);
  });

  it('trims whitespace from git output', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '  abc1234  \n' });

    expect(await getGitHash()).toBe('abc1234');
  });

  it('returns null when git exits with an error', async () => {
    mockExeca.mockRejectedValueOnce(new Error('not a git repository'));

    expect(await getGitHash()).toBeNull();
  });

  it('returns null when git output is empty', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '   ' });

    expect(await getGitHash()).toBeNull();
  });
});
