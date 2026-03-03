import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execute, name, schema, simpleGlobMatch } from './fs-glob.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-glob-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('fs-glob schema', () => {
  it('has correct name and shape', () => {
    expect(name).toBe('list_files');
    expect(schema.type).toBe('function');
    expect(schema.function.name).toBe('list_files');
    expect(schema.function.parameters).toHaveProperty('required', ['pattern']);
  });
});

describe('simpleGlobMatch', () => {
  it('matches *.ts against .ts files', () => {
    expect(simpleGlobMatch('foo.ts', '*.ts')).toBe(true);
    expect(simpleGlobMatch('foo.js', '*.ts')).toBe(false);
  });

  it('matches **/*.ts recursively', () => {
    expect(simpleGlobMatch('src/foo.ts', '**/*.ts')).toBe(true);
    expect(simpleGlobMatch('src/deep/bar.ts', '**/*.ts')).toBe(true);
    expect(simpleGlobMatch('foo.js', '**/*.ts')).toBe(false);
  });

  it('matches ** alone for any path', () => {
    expect(simpleGlobMatch('foo.ts', '**')).toBe(true);
    expect(simpleGlobMatch('src/foo.ts', '**')).toBe(true);
  });

  it('matches ? as a single character', () => {
    expect(simpleGlobMatch('a.ts', '?.ts')).toBe(true);
    expect(simpleGlobMatch('ab.ts', '?.ts')).toBe(false);
  });
});

describe('fs-glob execute', () => {
  it('keeps valid in-root patterns working', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.ts'), '');
    await fs.writeFile(path.join(tmpDir, 'b.ts'), '');
    await fs.writeFile(path.join(tmpDir, 'c.js'), '');

    const r = await execute({ pattern: '*.ts', path: tmpDir }, [tmpDir]);
    expect(r.ok).toBe(true);
    expect(r.result).toContain('a.ts');
    expect(r.result).toContain('b.ts');
    expect(r.result).not.toContain('c.js');
  });

  it('rejects absolute pattern /etc/*', async () => {
    const r = await execute({ pattern: '/etc/*', path: tmpDir }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('rejects traversal pattern ../../etc/*', async () => {
    const r = await execute({ pattern: '../../etc/*', path: tmpDir }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('rejects traversal hidden in brace expansion', async () => {
    const r = await execute({ pattern: '{**/*.ts,../secret/*}', path: tmpDir }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('rejects traversal hidden in character classes', async () => {
    const r = await execute({ pattern: '[.][.]/etc/*', path: tmpDir }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('rejects traversal hidden via brace concatenation', async () => {
    const r = await execute({ pattern: '{.,.}{.,.}/etc/*', path: tmpDir }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('rejects absolute branch hidden in brace expansion', async () => {
    const r = await execute({ pattern: '{**/*.ts,/etc/*}', path: tmpDir }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('rejects drive-prefixed absolute patterns', async () => {
    const r = await execute({ pattern: 'C:\\Windows\\*', path: tmpDir }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('Invalid glob pattern');
  });

  it('fails closed if glob yields an out-of-root entry', async () => {
    const fsWithGlob = fs as unknown as {
      glob?: (pattern: string, options: { cwd: string }) => AsyncIterable<string>;
    };
    const originalGlob = fsWithGlob.glob;

    fsWithGlob.glob = async function* fakeGlob() {
      yield 'safe.ts';
      yield '../../etc/passwd';
    };

    try {
      const r = await execute({ pattern: '**/*', path: tmpDir }, [tmpDir]);
      expect(r.ok).toBe(false);
      expect(r.result).toContain('Unsafe glob match rejected');
    } finally {
      fsWithGlob.glob = originalGlob;
    }
  });

  it('fails closed if a matched symlink resolves outside allowed roots', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret');
    await fs.symlink(outsideFile, path.join(tmpDir, 'escape-link.txt'));

    try {
      const r = await execute({ pattern: '**/*', path: tmpDir }, [tmpDir]);
      expect(r.ok).toBe(false);
      expect(r.result).toContain('Unsafe glob match rejected');
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('returns message when no files match', async () => {
    const r = await execute({ pattern: '*.xyz', path: tmpDir }, [tmpDir]);
    expect(r.ok).toBe(true);
    expect(r.result).toContain('No files matched');
  });

  it('returns error when pattern is missing', async () => {
    const r = await execute({}, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('pattern');
  });

  it('uses first allowed root as default search path', async () => {
    await fs.writeFile(path.join(tmpDir, 'file.txt'), '');

    const r = await execute({ pattern: '*.txt' }, [tmpDir]);
    expect(r.ok).toBe(true);
    expect(r.result).toContain('file.txt');
  });
});
