import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearOverrides,
  loadOverrides,
  resolveOverridesPath,
  saveOverrides,
} from './runtime-overrides.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'runtime-overrides-'));
}

describe('resolveOverridesPath', () => {
  it('uses configured data dir when provided', () => {
    const out = resolveOverridesPath('/var/lib/discoclaw', '/repo');
    expect(out).toBe(path.join('/var/lib/discoclaw', 'runtime-overrides.json'));
  });

  it('falls back to <projectRoot>/data when data dir is empty string', () => {
    const out = resolveOverridesPath('', '/repo');
    expect(out).toBe(path.join('/repo', 'data', 'runtime-overrides.json'));
  });

  it('falls back to <projectRoot>/data when data dir is undefined', () => {
    const out = resolveOverridesPath(undefined, '/repo');
    expect(out).toBe(path.join('/repo', 'data', 'runtime-overrides.json'));
  });
});

describe('loadOverrides', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('returns empty object when file does not exist', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const result = await loadOverrides(path.join(dir, 'runtime-overrides.json'));
    expect(result).toEqual({});
  });

  it('loads runtimeModel and voiceModel from a valid file', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ runtimeModel: 'opus', voiceModel: 'haiku' }), 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({ runtimeModel: 'opus', voiceModel: 'haiku' });
  });

  it('returns empty object for corrupt JSON', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, 'not-valid-json', 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({});
  });

  it('returns empty object when JSON root is an array', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify(['opus']), 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({});
  });

  it('returns empty object when JSON root is a primitive', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify(42), 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({});
  });

  it('silently drops unknown fields', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ runtimeModel: 'sonnet', unknownField: 'x' }), 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({ runtimeModel: 'sonnet' });
  });

  it('silently drops fields with wrong types', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ runtimeModel: 99, voiceModel: true }), 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({});
  });

  it('loads only runtimeModel when voiceModel is absent', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ runtimeModel: 'sonnet' }), 'utf-8');
    const result = await loadOverrides(filePath);
    expect(result).toEqual({ runtimeModel: 'sonnet' });
  });
});

describe('saveOverrides', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('writes overrides and reads them back correctly', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await saveOverrides(filePath, { runtimeModel: 'sonnet', voiceModel: 'haiku' });
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ runtimeModel: 'sonnet', voiceModel: 'haiku' });
  });

  it('creates the parent directory when it does not exist', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'subdir', 'runtime-overrides.json');
    await saveOverrides(filePath, { voiceModel: 'opus' });
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ voiceModel: 'opus' });
  });

  it('leaves no tmp file behind after a successful write', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await saveOverrides(filePath, { runtimeModel: 'opus' });
    const files = await fs.readdir(dir);
    const tmpFiles = files.filter((f) => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('overwrites an existing overrides file', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await saveOverrides(filePath, { runtimeModel: 'sonnet' });
    await saveOverrides(filePath, { runtimeModel: 'opus' });
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ runtimeModel: 'opus' });
  });

  it('writes an empty overrides object', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await saveOverrides(filePath, {});
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({});
  });
});

describe('clearOverrides', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await fs.rm(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('deletes the overrides file', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await fs.writeFile(filePath, JSON.stringify({ runtimeModel: 'sonnet' }), 'utf-8');
    await clearOverrides(filePath);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('does nothing when the file does not exist', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    // Should not throw.
    await clearOverrides(filePath);
  });

  it('after clear, loadOverrides returns empty object', async () => {
    const dir = await tmpDir();
    dirs.push(dir);
    const filePath = path.join(dir, 'runtime-overrides.json');
    await saveOverrides(filePath, { runtimeModel: 'opus' });
    await clearOverrides(filePath);
    const result = await loadOverrides(filePath);
    expect(result).toEqual({});
  });
});
