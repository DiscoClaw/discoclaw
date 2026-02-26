import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execute, name, schema } from './fs-write-file.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-write-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('fs-write-file schema', () => {
  it('has correct name and shape', () => {
    expect(name).toBe('write_file');
    expect(schema.type).toBe('function');
    expect(schema.function.name).toBe('write_file');
    expect(schema.function.parameters).toHaveProperty('required', ['file_path', 'content']);
  });
});

describe('fs-write-file execute', () => {
  it('writes a new file and creates parent directories', async () => {
    const filePath = path.join(tmpDir, 'sub', 'dir', 'output.txt');
    const r = await execute(
      { file_path: filePath, content: 'created!' },
      [tmpDir],
    );
    expect(r.ok).toBe(true);

    const contents = await fs.readFile(filePath, 'utf-8');
    expect(contents).toBe('created!');
  });

  it('overwrites an existing file', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    await fs.writeFile(filePath, 'old content');

    const r = await execute(
      { file_path: filePath, content: 'new content' },
      [tmpDir],
    );
    expect(r.ok).toBe(true);

    const contents = await fs.readFile(filePath, 'utf-8');
    expect(contents).toBe('new content');
  });

  it('returns error when content is missing', async () => {
    const r = await execute(
      { file_path: path.join(tmpDir, 'x.txt') },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toContain('content');
  });

  it('returns error when file_path is missing', async () => {
    const r = await execute({ content: 'data' }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('file_path');
  });

  it('rejects write outside allowed roots', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-outside-'));
    const filePath = path.join(outsideDir, 'injected.txt');

    const r = await execute(
      { file_path: filePath, content: 'injected' },
      [tmpDir],
    );
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/outside allowed roots|not accessible/i);

    await expect(fs.access(filePath)).rejects.toThrow();
    await fs.rm(outsideDir, { recursive: true, force: true });
  });
});
