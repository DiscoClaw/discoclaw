import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execute, name, schema } from './fs-read-file.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-read-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('fs-read-file schema', () => {
  it('has correct name and shape', () => {
    expect(name).toBe('read_file');
    expect(schema.type).toBe('function');
    expect(schema.function.name).toBe('read_file');
    expect(schema.function.parameters).toHaveProperty('required', ['file_path']);
  });
});

describe('fs-read-file execute', () => {
  it('reads an existing file', async () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    await fs.writeFile(filePath, 'hello world\n');

    const r = await execute({ file_path: filePath }, [tmpDir]);
    expect(r.ok).toBe(true);
    expect(r.result).toBe('hello world\n');
  });

  it('returns error for nonexistent file', async () => {
    const r = await execute({ file_path: path.join(tmpDir, 'nope.txt') }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/ENOENT|no such file|not accessible/i);
  });

  it('reads with offset and limit', async () => {
    const filePath = path.join(tmpDir, 'lines.txt');
    await fs.writeFile(filePath, 'line1\nline2\nline3\nline4\nline5\n');

    const r = await execute(
      { file_path: filePath, offset: 2, limit: 2 },
      [tmpDir],
    );
    expect(r.ok).toBe(true);
    expect(r.result).toBe('line2\nline3');
  });

  it('returns error when file_path is missing', async () => {
    const r = await execute({}, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toContain('file_path');
  });

  it('rejects path outside allowed roots', async () => {
    const r = await execute({ file_path: '/etc/hostname' }, [tmpDir]);
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/outside allowed roots|not accessible/i);
  });
});
