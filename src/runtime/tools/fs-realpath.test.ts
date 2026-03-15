import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execute, name, schema } from './fs-realpath.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-realpath-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('fs-realpath schema', () => {
  it('has correct name and shape', () => {
    expect(name).toBe('realpath');
    expect(schema.type).toBe('function');
    expect(schema.function.name).toBe('realpath');
    expect(schema.function.parameters).toHaveProperty('required', ['file_path']);
  });
});

describe('fs-realpath execute', () => {
  it('resolves an existing file to its canonical path', async () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    await fs.writeFile(filePath, 'hello');

    const r = await execute({ file_path: filePath }, [tmpDir]);
    expect(r.ok).toBe(true);
    // The result should be the canonical path
    const expected = await fs.realpath(filePath);
    expect(r.result).toBe(expected);
  });

  it('resolves a symlink to its target', async () => {
    const target = path.join(tmpDir, 'target.txt');
    await fs.writeFile(target, 'content');
    const link = path.join(tmpDir, 'link.txt');
    await fs.symlink(target, link);

    const r = await execute({ file_path: link }, [tmpDir]);
    expect(r.ok).toBe(true);
    expect(r.result).toBe(await fs.realpath(target));
  });

  it('resolves a relative path against the first allowed root', async () => {
    await fs.writeFile(path.join(tmpDir, 'rel.txt'), 'data');

    const r = await execute({ file_path: 'rel.txt' }, [tmpDir]);
    expect(r.ok).toBe(true);
    expect(r.result).toBe(await fs.realpath(path.join(tmpDir, 'rel.txt')));
  });

  it('returns error for nonexistent path', async () => {
    const r = await execute({ file_path: path.join(tmpDir, 'nope.txt') }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('does not exist');
  });

  it('returns error when file_path is missing', async () => {
    const r = await execute({}, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('file_path');
  });

  it('rejects symlink pointing outside allowed roots', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret');

    const link = path.join(tmpDir, 'escape');
    await fs.symlink(outsideFile, link);

    const r = await execute({ file_path: link }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('outside allowed roots');

    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it('rejects absolute path outside allowed roots', async () => {
    const r = await execute({ file_path: '/etc/hostname' }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/outside allowed roots|does not exist/i);
  });
});
