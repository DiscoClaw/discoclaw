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
  it('finds files matching a glob pattern', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.ts'), '');
    await fs.writeFile(path.join(tmpDir, 'b.ts'), '');
    await fs.writeFile(path.join(tmpDir, 'c.js'), '');

    const r = await execute({ pattern: '*.ts', path: tmpDir }, [tmpDir]);
    expect(r.ok).toBe(true);
    expect(r.result).toContain('a.ts');
    expect(r.result).toContain('b.ts');
    expect(r.result).not.toContain('c.js');
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
